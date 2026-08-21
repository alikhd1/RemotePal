//! Vault key management: key pairs live in ~/.remotepal/keys, shared
//! with RemotePal-python. Generation shells out to the OS ssh-keygen
//! (bundled with Windows OpenSSH); missing .pub files are derived with
//! `ssh-keygen -y`.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use crate::connections::vault_dir;

fn keys_dir() -> Result<PathBuf, String> {
    Ok(vault_dir()?.join("keys"))
}

fn ssh_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir().ok_or("no home directory")?.join(".ssh"))
}

fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains(['/', '\\', ':'])
        || name.starts_with('.')
        || name.ends_with(".pub")
    {
        return Err("invalid key name".into());
    }
    Ok(())
}

fn run_ssh_keygen(args: &[&str]) -> Result<String, String> {
    let out = Command::new("ssh-keygen")
        .args(args)
        .output()
        .map_err(|e| format!("cannot run ssh-keygen: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ssh-keygen failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn looks_like_private_key(path: &PathBuf) -> bool {
    std::fs::read_to_string(path)
        .map(|t| t.starts_with("-----BEGIN") && t.contains("PRIVATE KEY"))
        .unwrap_or(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultKey {
    pub name: String,
    pub path: String,
    pub public_key: Option<String>,
}

#[tauri::command]
pub fn keys_list() -> Result<Vec<VaultKey>, String> {
    let dir = keys_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut keys = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".pub") || !entry.path().is_file() {
            continue;
        }
        let public_key = std::fs::read_to_string(dir.join(format!("{name}.pub")))
            .ok()
            .map(|t| t.trim().to_string());
        keys.push(VaultKey {
            path: entry.path().to_string_lossy().into_owned(),
            name,
            public_key,
        });
    }
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(keys)
}

#[tauri::command]
pub fn key_generate(name: String) -> Result<(), String> {
    let name = name.trim();
    valid_name(name)?;
    let dir = keys_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(name);
    if target.exists() {
        return Err(format!("a key named {name} already exists"));
    }
    run_ssh_keygen(&[
        "-t",
        "ed25519",
        "-N",
        "",
        "-q",
        "-C",
        &format!("remotepal-{name}"),
        "-f",
        &target.to_string_lossy(),
    ])?;
    Ok(())
}

/// Copy a private key (and its .pub, derived when missing) into the vault.
#[tauri::command]
pub fn key_import_file(path: String) -> Result<String, String> {
    let src = PathBuf::from(path.trim());
    let name = src
        .file_name()
        .ok_or("bad path")?
        .to_string_lossy()
        .into_owned();
    valid_name(&name)?;
    let dir = keys_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(&name);
    if target.exists() {
        return Err(format!("a key named {name} already exists"));
    }
    std::fs::copy(&src, &target).map_err(|e| e.to_string())?;
    let src_pub = PathBuf::from(format!("{}.pub", src.to_string_lossy()));
    if src_pub.exists() {
        std::fs::copy(&src_pub, dir.join(format!("{name}.pub")))
            .map_err(|e| e.to_string())?;
    } else if let Ok(public) = run_ssh_keygen(&["-y", "-f", &target.to_string_lossy()]) {
        let _ = std::fs::write(dir.join(format!("{name}.pub")), public.trim());
    }
    Ok(name)
}

/// Import every private key found in ~/.ssh that the vault doesn't
/// have yet. Returns the imported names.
#[tauri::command]
pub fn keys_import_os() -> Result<Vec<String>, String> {
    let ssh = ssh_dir()?;
    if !ssh.exists() {
        return Ok(Vec::new());
    }
    let dir = keys_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut imported = Vec::new();
    for entry in std::fs::read_dir(&ssh).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if name.ends_with(".pub")
            || ["config", "known_hosts", "authorized_keys", "agent.env"]
                .contains(&name.as_str())
            || !path.is_file()
            || !looks_like_private_key(&path)
            || dir.join(&name).exists()
        {
            continue;
        }
        if key_import_file(path.to_string_lossy().into_owned()).is_ok() {
            imported.push(name);
        }
    }
    Ok(imported)
}

/// Copy a vault key pair into ~/.ssh so plain `ssh` can use it.
#[tauri::command]
pub fn key_install_os(name: String) -> Result<(), String> {
    valid_name(name.trim())?;
    let src = keys_dir()?.join(name.trim());
    if !src.is_file() {
        return Err("no such key".into());
    }
    let ssh = ssh_dir()?;
    std::fs::create_dir_all(&ssh).map_err(|e| e.to_string())?;
    let target = ssh.join(name.trim());
    if target.exists() {
        return Err(format!("~/.ssh/{} already exists", name.trim()));
    }
    std::fs::copy(&src, &target).map_err(|e| e.to_string())?;
    let src_pub = keys_dir()?.join(format!("{}.pub", name.trim()));
    if src_pub.exists() {
        let _ = std::fs::copy(&src_pub, ssh.join(format!("{}.pub", name.trim())));
    }
    Ok(())
}

#[tauri::command]
pub fn key_delete(name: String) -> Result<(), String> {
    valid_name(name.trim())?;
    let dir = keys_dir()?;
    std::fs::remove_file(dir.join(name.trim())).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(dir.join(format!("{}.pub", name.trim())));
    Ok(())
}
