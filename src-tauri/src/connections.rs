//! Saved connections: metadata in ~/.remotepal/connections.json,
//! passwords in the OS credential store (Windows Credential Manager).
//! The PyQt app's servers.json lives in the same directory and is only
//! ever read (legacy import), never written.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::ssh::{self, ConnectError, SshSessions};

const KEYRING_SERVICE: &str = "RemotePal";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub key_path: String,
    #[serde(default)]
    pub has_password: bool,
}

/// Serializes read-modify-write cycles on connections.json.
#[derive(Default)]
pub struct StoreLock(pub Mutex<()>);

pub(crate) fn vault_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("REMOTEPAL_VAULT_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(dirs::home_dir()
        .ok_or("no home directory")?
        .join(".remotepal"))
}

fn store_path() -> Result<PathBuf, String> {
    Ok(vault_dir()?.join("connections.json"))
}

fn load_all() -> Result<Vec<SavedConnection>, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("corrupt connections.json: {e}"))
}

fn save_all(list: &[SavedConnection]) -> Result<(), String> {
    fs::create_dir_all(vault_dir()?).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(store_path()?, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn connections_list(lock: State<'_, StoreLock>) -> Result<Vec<SavedConnection>, String> {
    let _guard = lock.0.lock().unwrap();
    load_all()
}

/// `password` semantics: `Some(non-empty)` stores it, `Some("")` clears
/// a stored one, `None` leaves whatever is stored untouched.
#[tauri::command]
pub fn connection_save(
    lock: State<'_, StoreLock>,
    mut conn: SavedConnection,
    password: Option<String>,
) -> Result<SavedConnection, String> {
    let _guard = lock.0.lock().unwrap();
    let mut list = load_all()?;
    if conn.id.is_empty() {
        conn.id = uuid::Uuid::new_v4().to_string();
    }
    let existing = list.iter().position(|c| c.id == conn.id);
    conn.has_password = match &password {
        Some(pw) if !pw.is_empty() => {
            keyring::Entry::new(KEYRING_SERVICE, &conn.id)
                .and_then(|e| e.set_password(pw))
                .map_err(|e| format!("cannot store password: {e}"))?;
            true
        }
        Some(_) => {
            if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &conn.id) {
                let _ = entry.delete_credential();
            }
            false
        }
        None => existing.map(|i| list[i].has_password).unwrap_or(false),
    };
    match existing {
        Some(i) => list[i] = conn.clone(),
        None => list.push(conn.clone()),
    }
    save_all(&list)?;
    Ok(conn)
}

#[tauri::command]
pub fn connection_delete(lock: State<'_, StoreLock>, id: String) -> Result<(), String> {
    let _guard = lock.0.lock().unwrap();
    let mut list = load_all()?;
    list.retain(|c| c.id != id);
    save_all(&list)?;
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_connect_saved(
    app: AppHandle,
    sessions: State<'_, SshSessions>,
    lock: State<'_, StoreLock>,
    id: String,
) -> Result<u32, ConnectError> {
    let conn = {
        let _guard = lock.0.lock().unwrap();
        load_all()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| ConnectError::other("saved connection not found"))?
    };
    let password = if conn.has_password {
        Some(
            keyring::Entry::new(KEYRING_SERVICE, &conn.id)
                .and_then(|e| e.get_password())
                .map_err(|e| ConnectError::other(format!("cannot read stored password: {e}")))?,
        )
    } else {
        None
    };
    let key_path = (!conn.key_path.is_empty()).then(|| conn.key_path.clone());
    ssh::start_session(
        app,
        &sessions,
        &conn.host,
        conn.port,
        &conn.user,
        password,
        key_path,
    )
    .await
}

/// Tests that set REMOTEPAL_VAULT_DIR must hold this so parallel test
/// threads don't race on the process-wide env var.
#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_roundtrip() {
        let _guard = test_env_lock().lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "remotepal-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::env::set_var("REMOTEPAL_VAULT_DIR", &dir);

        // roundtrip
        let conn = SavedConnection {
            id: "abc".into(),
            name: "demo".into(),
            host: "h".into(),
            port: 2222,
            user: "u".into(),
            key_path: String::new(),
            has_password: false,
        };
        save_all(std::slice::from_ref(&conn)).unwrap();
        let loaded = load_all().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "abc");
        assert_eq!(loaded[0].port, 2222);

        // camelCase over the IPC boundary
        let json = serde_json::to_string(&conn).unwrap();
        assert!(json.contains("\"keyPath\""), "{json}");
        assert!(json.contains("\"hasPassword\""), "{json}");

        std::env::remove_var("REMOTEPAL_VAULT_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
