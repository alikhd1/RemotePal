//! Saved connections: metadata in ~/.remotepal/connections.json,
//! passwords in the OS credential store (Windows Credential Manager).
//! RemotePal-python's servers.json lives in the same directory and is
//! only ever read (legacy import), never written.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::ssh::{self, ConnectError, ConnectSpec, SshSessions};

pub(crate) const KEYRING_SERVICE: &str = "RemotePal";

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedForward {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

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
    /// id of another saved connection used as jump host ("" = direct)
    #[serde(default)]
    pub jump: String,
    /// local forwards started automatically on connect
    #[serde(default)]
    pub forwards: Vec<SavedForward>,
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

pub fn load_all() -> Result<Vec<SavedConnection>, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("corrupt connections.json: {e}"))
}

pub(crate) fn save_all(list: &[SavedConnection]) -> Result<(), String> {
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
    let _ = crate::sshconfig::sync_ssh_config();
    Ok(conn)
}

#[tauri::command]
pub fn connection_delete(lock: State<'_, StoreLock>, id: String) -> Result<(), String> {
    let _guard = lock.0.lock().unwrap();
    let mut list = load_all()?;
    list.retain(|c| c.id != id);
    save_all(&list)?;
    let _ = crate::sshconfig::sync_ssh_config();
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

fn spec_from_saved(conn: &SavedConnection) -> Result<ConnectSpec, String> {
    let password = if conn.has_password {
        Some(
            keyring::Entry::new(KEYRING_SERVICE, &conn.id)
                .and_then(|e| e.get_password())
                .map_err(|e| format!("cannot read stored password for {}: {e}", conn.name))?,
        )
    } else {
        None
    };
    Ok(ConnectSpec {
        host: conn.host.clone(),
        port: conn.port,
        user: conn.user.clone(),
        password,
        key_path: (!conn.key_path.is_empty()).then(|| conn.key_path.clone()),
    })
}

/// Expand a target + optional jump-connection id into the full chain,
/// outermost jump first. Follows nested jumps with cycle detection.
pub fn resolve_chain(
    lock: &State<'_, StoreLock>,
    target: ConnectSpec,
    jump_id: Option<String>,
) -> Result<Vec<ConnectSpec>, String> {
    let _guard = lock.0.lock().unwrap();
    let list = load_all()?;
    let mut specs = vec![target];
    let mut next = jump_id.filter(|s| !s.is_empty());
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = next {
        if !seen.insert(id.clone()) {
            return Err("jump host cycle detected".into());
        }
        if seen.len() > 5 {
            return Err("jump chain too deep (max 5)".into());
        }
        let conn = list
            .iter()
            .find(|c| c.id == id)
            .ok_or("jump connection not found")?;
        specs.push(spec_from_saved(conn)?);
        next = Some(conn.jump.clone()).filter(|s| !s.is_empty());
    }
    specs.reverse();
    Ok(specs)
}

#[tauri::command]
pub async fn ssh_connect_saved(
    app: AppHandle,
    sessions: State<'_, SshSessions>,
    forwards: State<'_, crate::forwards::Forwards>,
    lock: State<'_, StoreLock>,
    id: String,
) -> Result<u32, ConnectError> {
    let (target, jump, saved_forwards) = {
        let _guard = lock.0.lock().unwrap();
        let conn = load_all()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| ConnectError::other("saved connection not found"))?;
        (spec_from_saved(&conn)?, conn.jump, conn.forwards)
    };
    let specs = resolve_chain(&lock, target, Some(jump))?;
    let session_id = ssh::start_session(app, &sessions, &specs).await?;
    // auto-start pinned forwards; individual failures (port in use)
    // are non-fatal — the Forwards panel shows what actually started
    for fwd in saved_forwards {
        let _ = crate::forwards::start_for_session(
            &sessions,
            &forwards,
            session_id,
            fwd.local_port,
            fwd.remote_host,
            fwd.remote_port,
        )
        .await;
    }
    Ok(session_id)
}

/// ssh-copy-id: append a public key to the server's authorized_keys.
/// Useful when the server only accepts password auth so far — after
/// deploying, key auth works. Idempotent (grep before append).
#[tauri::command]
pub async fn deploy_key(
    lock: State<'_, StoreLock>,
    id: String,
    pub_key_path: String,
) -> Result<(), ConnectError> {
    let text = std::fs::read_to_string(pub_key_path.trim())
        .map_err(|e| ConnectError::other(format!("cannot read public key: {e}")))?;
    let pub_key = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    let looks_like_pubkey = pub_key.starts_with("ssh-")
        || pub_key.starts_with("ecdsa-")
        || pub_key.starts_with("sk-");
    if !looks_like_pubkey {
        return Err(ConnectError::other(
            "that file does not look like an OpenSSH public key (.pub)",
        ));
    }

    let (target, jump) = {
        let _guard = lock.0.lock().unwrap();
        let conn = load_all()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| ConnectError::other("saved connection not found"))?;
        (spec_from_saved(&conn)?, conn.jump)
    };
    let specs = resolve_chain(&lock, target, Some(jump))?;
    let chain = ssh::connect_chain(&specs).await?;
    let session = chain.last().expect("chain not empty");

    let quoted = pub_key.replace('\'', "'\\''");
    let command = format!(
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
         touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && \
         (grep -qxF '{quoted}' ~/.ssh/authorized_keys || \
         echo '{quoted}' >> ~/.ssh/authorized_keys)"
    );
    let result = ssh::exec_on(session, &command).await;
    for handle in chain.iter().rev() {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    let (status, stderr) = result.map_err(ConnectError::other)?;
    if status != 0 {
        return Err(ConnectError::other(format!(
            "deploy failed (exit {status}){}",
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        )));
    }
    Ok(())
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
            jump: String::new(),
            forwards: Vec::new(),
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
