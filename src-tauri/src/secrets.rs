//! Every secret RemotePal stores goes through here: SSH connection
//! passwords, S3 secret keys, and AI provider keys.
//!
//! Two backing stores. Normally secrets live in the OS credential store
//! via the `keyring` crate. With biometric protection switched on (macOS)
//! they instead live in the data-protection keychain behind a user
//! presence policy, so reading one asks for Touch ID rather than showing
//! the "allow access" panel — see `biometric.rs`.
//!
//! Reads try the protected store first and fall back to the plain one, so
//! secrets saved before protection was enabled keep working and nothing
//! is stranded if it is switched off again.
//!
//! Reads are cached for the life of the process. Connecting, listing a
//! bucket and chatting all read the same secret repeatedly; without the
//! cache each one would be its own Touch ID prompt.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const SERVICE_CONNECTIONS: &str = "RemotePal";
pub const SERVICE_S3: &str = "RemotePal-S3";
pub const SERVICE_AI: &str = "RemotePal-AI";

fn cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(service: &str, account: &str) -> String {
    format!("{service}\u{0}{account}")
}

/// What the Touch ID panel says it is unlocking.
fn prompt_for(service: &str) -> &'static str {
    match service {
        SERVICE_CONNECTIONS => "unlock the saved password for this connection",
        SERVICE_S3 => "unlock this S3 secret key",
        SERVICE_AI => "unlock your AI API key",
        _ => "unlock a saved RemotePal secret",
    }
}

// ------------------------------------------------------- the setting

fn flag_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::connections::vault_dir()?.join("biometric"))
}

/// Whether new secrets are written behind Touch ID.
pub fn biometric_enabled() -> bool {
    flag_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

pub fn set_biometric_enabled(on: bool) -> Result<(), String> {
    let path = flag_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, if on { "1" } else { "0" }).map_err(|e| e.to_string())
}

// ------------------------------------------------------- read / write

/// A stored secret, or None when there isn't one. Returns None too when
/// a Touch ID prompt is declined — we don't quietly fall through to an
/// unprotected copy of the thing the user just refused to unlock.
pub fn get(service: &str, account: &str) -> Option<String> {
    let key = cache_key(service, account);
    if let Some(v) = cache().lock().unwrap().get(&key) {
        return Some(v.clone());
    }

    let found = match crate::biometric::get(service, account, prompt_for(service)) {
        Ok(Some(v)) => Some(v),
        Err(_) => return None,
        Ok(None) => keyring::Entry::new(service, account)
            .and_then(|e| e.get_password())
            .ok(),
    }?;

    cache().lock().unwrap().insert(key, found.clone());
    Some(found)
}

/// Store a secret in whichever backing store the setting selects, and
/// clear it from the other so there is only ever one copy.
pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
    // Protection is a hardening option; it must never be the reason a
    // credential cannot be saved. If the protected store rejects the
    // write — an unsigned build has no entitlement for it — fall back to
    // the ordinary one and turn the setting off, since it demonstrably
    // does not work here and would fail the same way next time.
    if biometric_enabled() {
        match crate::biometric::set(service, account, value) {
            Ok(()) => {
                if let Ok(entry) = keyring::Entry::new(service, account) {
                    let _ = entry.delete_credential();
                }
            }
            Err(_) => {
                let _ = set_biometric_enabled(false);
                keyring::Entry::new(service, account)
                    .and_then(|e| e.set_password(value))
                    .map_err(|e| format!("cannot store secret: {e}"))?;
            }
        }
    } else {
        let _ = crate::biometric::delete(service, account);
        keyring::Entry::new(service, account)
            .and_then(|e| e.set_password(value))
            .map_err(|e| format!("cannot store secret: {e}"))?;
    }
    cache()
        .lock()
        .unwrap()
        .insert(cache_key(service, account), value.to_string());
    Ok(())
}

pub fn delete(service: &str, account: &str) {
    let _ = crate::biometric::delete(service, account);
    if let Ok(entry) = keyring::Entry::new(service, account) {
        let _ = entry.delete_credential();
    }
    cache().lock().unwrap().remove(&cache_key(service, account));
}

/// Move one secret between the two stores, if it exists. Used when the
/// setting is toggled — without this, turning protection on would leave
/// everything already saved unprotected.
fn migrate_one(service: &str, account: &str, to_biometric: bool) -> bool {
    let existing = if to_biometric {
        keyring::Entry::new(service, account)
            .and_then(|e| e.get_password())
            .ok()
    } else {
        crate::biometric::get(service, account, prompt_for(service))
            .ok()
            .flatten()
    };
    let Some(value) = existing else { return false };

    let moved = if to_biometric {
        crate::biometric::set(service, account, &value).is_ok()
    } else {
        keyring::Entry::new(service, account)
            .and_then(|e| e.set_password(&value))
            .is_ok()
    };
    if !moved {
        return false;
    }
    // only drop the old copy once the new one is written
    if to_biometric {
        if let Ok(entry) = keyring::Entry::new(service, account) {
            let _ = entry.delete_credential();
        }
    } else {
        let _ = crate::biometric::delete(service, account);
    }
    true
}

// ------------------------------------------------------- commands

/// Whether this machine can gate secrets behind Touch ID, and whether it
/// is currently doing so.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricStatus {
    pub available: bool,
    pub enabled: bool,
}

#[tauri::command]
pub fn secrets_biometric_status() -> BiometricStatus {
    BiometricStatus {
        available: crate::biometric::available(),
        enabled: biometric_enabled(),
    }
}

/// Turn Touch ID protection on or off and move existing secrets across.
/// `ai_providers` comes from the frontend because the provider list is
/// user-extensible and only it knows the full set.
#[tauri::command]
pub fn secrets_biometric_set(
    enabled: bool,
    ai_providers: Option<Vec<String>>,
) -> Result<u32, String> {
    if enabled && !crate::biometric::available() {
        return Err("This machine can't gate secrets behind Touch ID.".to_string());
    }

    let mut moved = 0u32;
    for id in crate::connections::saved_ids().unwrap_or_default() {
        if migrate_one(SERVICE_CONNECTIONS, &id, enabled) {
            moved += 1;
        }
    }
    for id in crate::s3::saved_ids().unwrap_or_default() {
        if migrate_one(SERVICE_S3, &id, enabled) {
            moved += 1;
        }
    }
    for provider in ai_providers.unwrap_or_default() {
        if migrate_one(SERVICE_AI, &provider, enabled) {
            moved += 1;
        }
    }

    set_biometric_enabled(enabled)?;
    cache().lock().unwrap().clear();
    Ok(moved)
}
