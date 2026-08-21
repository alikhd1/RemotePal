//! Encrypted vault backups, byte-compatible with the PyQt app:
//! `RPAL1 + salt(16) + Fernet(tar.gz)`, key = PBKDF2-HMAC-SHA256 with
//! 600k iterations. The archive carries the PyQt-schema files
//! (servers.json, passwords.json, storages.json, snippets.json,
//! keys/*) so either app can restore it, plus a native manifest
//! (remotepal2.json) for lossless restore of ids/jumps/path-style.
//!
//! Snippets live in the same snippets.json the PyQt app uses.

use std::collections::HashMap;
use std::io::Read;
use std::num::NonZeroU32;

use base64::engine::general_purpose::URL_SAFE as B64URL;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::connections::{self, SavedConnection, StoreLock};
use crate::s3::{self, S3Storage, S3StoreLock};

const BACKUP_MAGIC: &[u8] = b"RPAL1";
const PBKDF2_ITERS: u32 = 600_000;

// ------------------------------------------------------------- snippets

#[derive(Clone, Serialize, Deserialize)]
pub struct Snippet {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub command: String,
}

fn snippets_path() -> Result<std::path::PathBuf, String> {
    Ok(connections::vault_dir()?.join("snippets.json"))
}

pub(crate) fn load_snippets() -> Result<Vec<Snippet>, String> {
    let path = snippets_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("corrupt snippets.json: {e}"))
}

pub(crate) fn save_snippets(list: &[Snippet]) -> Result<(), String> {
    std::fs::create_dir_all(connections::vault_dir()?).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(snippets_path()?, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn snippets_list() -> Result<Vec<Snippet>, String> {
    load_snippets()
}

#[tauri::command]
pub fn snippets_save(snippets: Vec<Snippet>) -> Result<(), String> {
    save_snippets(&snippets)
}

// ------------------------------------------------------------ crypto
//
// Fernet implemented against the spec (and Python's cryptography
// output): token = b64url(0x80 || ts_be64 || iv16 || AES128-CBC-PKCS7
// || HMAC-SHA256), key = 16B signing || 16B encryption.

fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    ring::pbkdf2::derive(
        ring::pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PBKDF2_ITERS).unwrap(),
        salt,
        password.as_bytes(),
        &mut key,
    );
    key
}

fn fernet_encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<String, String> {
    use aes::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};
    let (sign_key, enc_key) = key.split_at(16);
    let enc_key: [u8; 16] = enc_key.try_into().expect("split_at(16)");
    let mut iv = [0u8; 16];
    use ring::rand::SecureRandom;
    ring::rand::SystemRandom::new()
        .fill(&mut iv)
        .map_err(|_| "rng failure".to_string())?;
    let ciphertext = cbc::Encryptor::<aes::Aes128>::new(&enc_key.into(), &iv.into())
        .encrypt_padded_vec::<Pkcs7>(plaintext);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut token = Vec::with_capacity(1 + 8 + 16 + ciphertext.len() + 32);
    token.push(0x80);
    token.extend_from_slice(&timestamp.to_be_bytes());
    token.extend_from_slice(&iv);
    token.extend_from_slice(&ciphertext);
    let mac_key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, sign_key);
    let mac = ring::hmac::sign(&mac_key, &token);
    token.extend_from_slice(mac.as_ref());
    Ok(B64URL.encode(token))
}

fn fernet_decrypt(key: &[u8; 32], token: &str) -> Result<Vec<u8>, String> {
    use aes::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
    let bad = || "wrong password or corrupt backup".to_string();
    let data = B64URL.decode(token.trim()).map_err(|_| bad())?;
    if data.len() < 1 + 8 + 16 + 32 || data[0] != 0x80 {
        return Err(bad());
    }
    let (body, mac) = data.split_at(data.len() - 32);
    let (sign_key, enc_key) = key.split_at(16);
    let enc_key: [u8; 16] = enc_key.try_into().expect("split_at(16)");
    let mac_key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, sign_key);
    ring::hmac::verify(&mac_key, body, mac).map_err(|_| bad())?;
    let iv: [u8; 16] = body[9..25].try_into().map_err(|_| bad())?;
    cbc::Decryptor::<aes::Aes128>::new(&enc_key.into(), &iv.into())
        .decrypt_padded_vec::<Pkcs7>(&body[25..])
        .map_err(|_| bad())
}

// ---------------------------------------------------- PyQt-schema types

#[derive(Serialize, Deserialize)]
struct PyServer {
    #[serde(default)]
    name: String,
    host: String,
    #[serde(default)]
    user: String,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    key: String,
    #[serde(default)]
    group: String,
    #[serde(default)]
    jump: String,
    #[serde(default)]
    agent_forward: bool,
}

fn default_port() -> u16 {
    22
}

#[derive(Serialize, Deserialize)]
struct PyStorage {
    #[serde(default)]
    name: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    bucket: String,
    #[serde(default)]
    access_key: String,
    #[serde(default)]
    secret_key: String,
}

/// Native manifest: lossless restore of ids, jump links, path-style.
#[derive(Serialize, Deserialize)]
struct NativeManifest {
    connections: Vec<SavedConnection>,
    s3: Vec<S3Storage>,
    /// secrets keyed by id, resolved from the credential store
    conn_passwords: HashMap<String, String>,
    s3_secrets: HashMap<String, String>,
}

fn keyring_get(service: &str, account: &str) -> Option<String> {
    keyring::Entry::new(service, account)
        .and_then(|e| e.get_password())
        .ok()
}

fn keyring_set(service: &str, account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(service, account)
        .and_then(|e| e.set_password(value))
        .map_err(|e| format!("credential store: {e}"))
}

// ------------------------------------------------------------- export

fn tar_bytes(tar: &mut tar::Builder<Vec<u8>>, name: &str, data: &[u8]) -> Result<(), String> {
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    tar.append_data(&mut header, name, data)
        .map_err(|e| e.to_string())
}

pub fn export_backup(path: &str, password: &str) -> Result<(), String> {
    let conns = connections::load_all()?;
    let storages = s3::load_all()?;
    let snippets = load_snippets()?;

    let mut conn_passwords = HashMap::new();
    for conn in conns.iter().filter(|c| c.has_password) {
        if let Some(pw) = keyring_get(connections::KEYRING_SERVICE, &conn.id) {
            conn_passwords.insert(conn.id.clone(), pw);
        }
    }
    let mut s3_secrets = HashMap::new();
    for storage in &storages {
        if let Some(secret) = keyring_get(s3::KEYRING_SERVICE, &storage.id) {
            s3_secrets.insert(storage.id.clone(), secret);
        }
    }

    // PyQt-schema views (jump ids -> names, key paths -> bundled names)
    let name_of: HashMap<&str, &str> = conns
        .iter()
        .map(|c| (c.id.as_str(), c.name.as_str()))
        .collect();
    let mut key_files: HashMap<String, Vec<u8>> = HashMap::new();
    let py_servers: Vec<PyServer> = conns
        .iter()
        .map(|c| {
            let key = if c.key_path.is_empty() {
                String::new()
            } else {
                let base = std::path::Path::new(&c.key_path)
                    .file_name()
                    .map(|f| f.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if !base.is_empty() && !key_files.contains_key(&base) {
                    if let Ok(bytes) = std::fs::read(&c.key_path) {
                        key_files.insert(base.clone(), bytes);
                    }
                }
                base
            };
            PyServer {
                name: c.name.clone(),
                host: c.host.clone(),
                user: c.user.clone(),
                port: c.port,
                key,
                group: String::new(),
                jump: name_of.get(c.jump.as_str()).unwrap_or(&"").to_string(),
                agent_forward: false,
            }
        })
        .collect();
    let py_passwords: HashMap<String, String> = conns
        .iter()
        .filter_map(|c| {
            conn_passwords
                .get(&c.id)
                .map(|pw| (c.name.clone(), pw.clone()))
        })
        .collect();
    let py_storages: Vec<PyStorage> = storages
        .iter()
        .map(|s| PyStorage {
            name: s.name.clone(),
            endpoint: s.endpoint.clone(),
            region: s.region.clone(),
            bucket: s.bucket.clone(),
            access_key: s.access_key.clone(),
            secret_key: s3_secrets.get(&s.id).cloned().unwrap_or_default(),
        })
        .collect();

    let manifest = NativeManifest {
        connections: conns,
        s3: storages,
        conn_passwords,
        s3_secrets,
    };

    fn to_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
        serde_json::to_vec(value).map_err(|e| e.to_string())
    }
    let mut tar = tar::Builder::new(Vec::new());
    tar_bytes(&mut tar, "servers.json", &to_json(&py_servers)?)?;
    tar_bytes(&mut tar, "passwords.json", &to_json(&py_passwords)?)?;
    tar_bytes(&mut tar, "storages.json", &to_json(&py_storages)?)?;
    tar_bytes(&mut tar, "snippets.json", &to_json(&snippets)?)?;
    tar_bytes(&mut tar, "remotepal2.json", &to_json(&manifest)?)?;
    for (name, bytes) in &key_files {
        tar_bytes(&mut tar, &format!("keys/{name}"), bytes)?;
    }
    let tar_data = tar.into_inner().map_err(|e| e.to_string())?;

    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut gz, &tar_data).map_err(|e| e.to_string())?;
    let gz_data = gz.finish().map_err(|e| e.to_string())?;

    let mut salt = [0u8; 16];
    use ring::rand::SecureRandom;
    ring::rand::SystemRandom::new()
        .fill(&mut salt)
        .map_err(|_| "rng failure".to_string())?;
    let token = fernet_encrypt(&derive_key(password, &salt), &gz_data)?;

    let mut out = Vec::with_capacity(BACKUP_MAGIC.len() + 16 + token.len());
    out.extend_from_slice(BACKUP_MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(token.as_bytes());
    std::fs::write(path, out).map_err(|e| e.to_string())
}

// ------------------------------------------------------------- import

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub connections: usize,
    pub storages: usize,
    pub snippets: usize,
    pub keys: usize,
}

fn read_archive(path: &str, password: &str) -> Result<HashMap<String, Vec<u8>>, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    if raw.len() < BACKUP_MAGIC.len() + 16 || &raw[..BACKUP_MAGIC.len()] != BACKUP_MAGIC {
        return Err("not a RemotePal backup".into());
    }
    let salt = &raw[BACKUP_MAGIC.len()..BACKUP_MAGIC.len() + 16];
    let token = std::str::from_utf8(&raw[BACKUP_MAGIC.len() + 16..])
        .map_err(|_| "corrupt backup".to_string())?;
    let gz_data = fernet_decrypt(&derive_key(password, salt), token)?;
    let mut tar_data = Vec::new();
    flate2::read::GzDecoder::new(&gz_data[..])
        .read_to_end(&mut tar_data)
        .map_err(|e| e.to_string())?;
    let mut files = HashMap::new();
    let mut archive = tar::Archive::new(&tar_data[..]);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let mut data = Vec::new();
        entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
        files.insert(name, data);
    }
    Ok(files)
}

fn extract_keys(files: &HashMap<String, Vec<u8>>) -> Result<usize, String> {
    let keys_dir = connections::vault_dir()?.join("keys");
    let mut written = 0;
    for (name, data) in files {
        if let Some(base) = name.strip_prefix("keys/") {
            if base.is_empty() || base.contains('/') {
                continue;
            }
            std::fs::create_dir_all(&keys_dir).map_err(|e| e.to_string())?;
            let target = keys_dir.join(base);
            if !target.exists() {
                std::fs::write(&target, data).map_err(|e| e.to_string())?;
                written += 1;
            }
        }
    }
    Ok(written)
}

pub fn import_backup(path: &str, password: &str) -> Result<ImportSummary, String> {
    let files = read_archive(path, password)?;
    let mut summary = ImportSummary::default();
    summary.keys = extract_keys(&files)?;

    // snippets: merge by name
    if let Some(data) = files.get("snippets.json") {
        let incoming: Vec<Snippet> =
            serde_json::from_slice(data).map_err(|e| format!("snippets.json: {e}"))?;
        let mut current = load_snippets()?;
        for snip in incoming {
            if !current.iter().any(|s| s.name == snip.name) {
                current.push(snip);
                summary.snippets += 1;
            }
        }
        save_snippets(&current)?;
    }

    if let Some(data) = files.get("remotepal2.json") {
        // native restore: merge by id, secrets back into the store
        let manifest: NativeManifest =
            serde_json::from_slice(data).map_err(|e| format!("remotepal2.json: {e}"))?;
        let mut conns = connections::load_all()?;
        for incoming in manifest.connections {
            match conns.iter().position(|c| c.id == incoming.id) {
                Some(i) => conns[i] = incoming,
                None => {
                    conns.push(incoming);
                    summary.connections += 1;
                }
            }
        }
        connections::save_all(&conns)?;
        for (id, pw) in &manifest.conn_passwords {
            keyring_set(connections::KEYRING_SERVICE, id, pw)?;
        }
        let mut storages = s3::load_all()?;
        for incoming in manifest.s3 {
            match storages.iter().position(|s| s.id == incoming.id) {
                Some(i) => storages[i] = incoming,
                None => {
                    storages.push(incoming);
                    summary.storages += 1;
                }
            }
        }
        s3::save_all(&storages)?;
        for (id, secret) in &manifest.s3_secrets {
            keyring_set(s3::KEYRING_SERVICE, id, secret)?;
        }
        return Ok(summary);
    }

    // PyQt backup: map schemas
    let keys_dir = connections::vault_dir()?.join("keys");
    if let Some(data) = files.get("servers.json") {
        let servers: Vec<PyServer> =
            serde_json::from_slice(data).map_err(|e| format!("servers.json: {e}"))?;
        let passwords: HashMap<String, Option<String>> = files
            .get("passwords.json")
            .map(|d| serde_json::from_slice(d).unwrap_or_default())
            .unwrap_or_default();
        let mut conns = connections::load_all()?;
        // pass 1: create; remember name -> id for jump wiring
        let mut id_of: HashMap<String, String> = conns
            .iter()
            .map(|c| (c.name.clone(), c.id.clone()))
            .collect();
        let mut jump_names: Vec<(String, String)> = Vec::new(); // (id, jump name)
        for server in servers {
            if conns
                .iter()
                .any(|c| c.host == server.host && c.user == server.user && c.port == server.port)
            {
                continue;
            }
            let id = uuid::Uuid::new_v4().to_string();
            let key_file = keys_dir.join(&server.key);
            let has_password = matches!(
                passwords.get(&server.name),
                Some(Some(pw)) if !pw.is_empty()
            );
            if has_password {
                if let Some(Some(pw)) = passwords.get(&server.name) {
                    keyring_set(connections::KEYRING_SERVICE, &id, pw)?;
                }
            }
            if !server.jump.is_empty() {
                jump_names.push((id.clone(), server.jump.clone()));
            }
            id_of.entry(server.name.clone()).or_insert_with(|| id.clone());
            conns.push(SavedConnection {
                id,
                name: if server.name.is_empty() {
                    format!("{}@{}", server.user, server.host)
                } else {
                    server.name
                },
                host: server.host,
                port: server.port,
                user: server.user,
                key_path: if !server.key.is_empty() && key_file.is_file() {
                    key_file.to_string_lossy().into_owned()
                } else {
                    String::new()
                },
                has_password,
                jump: String::new(),
            });
            summary.connections += 1;
        }
        // pass 2: wire jumps by name
        for (id, jump_name) in jump_names {
            if let Some(jump_id) = id_of.get(&jump_name).cloned() {
                if let Some(conn) = conns.iter_mut().find(|c| c.id == id) {
                    conn.jump = jump_id;
                }
            }
        }
        connections::save_all(&conns)?;
    }
    if let Some(data) = files.get("storages.json") {
        let incoming: Vec<PyStorage> =
            serde_json::from_slice(data).map_err(|e| format!("storages.json: {e}"))?;
        let mut storages = s3::load_all()?;
        for py in incoming {
            if storages
                .iter()
                .any(|s| s.bucket == py.bucket && s.endpoint == py.endpoint)
            {
                continue;
            }
            let id = uuid::Uuid::new_v4().to_string();
            if !py.secret_key.is_empty() {
                keyring_set(s3::KEYRING_SERVICE, &id, &py.secret_key)?;
            }
            storages.push(S3Storage {
                id,
                name: if py.name.is_empty() {
                    py.bucket.clone()
                } else {
                    py.name
                },
                endpoint: py.endpoint,
                region: py.region,
                bucket: py.bucket,
                access_key: py.access_key,
                path_style: false,
            });
            summary.storages += 1;
        }
        s3::save_all(&storages)?;
    }
    Ok(summary)
}

#[tauri::command]
pub fn vault_export(
    lock: State<'_, StoreLock>,
    s3_lock: State<'_, S3StoreLock>,
    path: String,
    password: String,
) -> Result<(), String> {
    if password.is_empty() {
        return Err("a backup passphrase is required".into());
    }
    let _guard = lock.0.lock().unwrap();
    let _s3_guard = s3_lock.0.lock().unwrap();
    export_backup(&path, &password)
}

#[tauri::command]
pub fn vault_import(
    lock: State<'_, StoreLock>,
    s3_lock: State<'_, S3StoreLock>,
    path: String,
    password: String,
) -> Result<ImportSummary, String> {
    let _guard = lock.0.lock().unwrap();
    let _s3_guard = s3_lock.0.lock().unwrap();
    import_backup(&path, &password)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_backup_roundtrip_without_secrets() {
        let _guard = crate::connections::test_env_lock().lock().unwrap();
        let dir = std::env::temp_dir().join(format!("remotepal-vault-{}", uuid::Uuid::new_v4()));
        std::env::set_var("REMOTEPAL_VAULT_DIR", &dir);

        let conns = vec![
            SavedConnection {
                id: "id-a".into(),
                name: "alpha".into(),
                host: "a.example".into(),
                port: 22,
                user: "root".into(),
                key_path: String::new(),
                has_password: false,
                jump: String::new(),
            },
            SavedConnection {
                id: "id-b".into(),
                name: "beta".into(),
                host: "b.example".into(),
                port: 2222,
                user: "ops".into(),
                key_path: String::new(),
                has_password: false,
                jump: "id-a".into(),
            },
        ];
        connections::save_all(&conns).unwrap();
        save_snippets(&[Snippet {
            name: "disk".into(),
            command: "df -h".into(),
        }])
        .unwrap();

        let backup = dir.join("test.rpal");
        let backup_str = backup.to_string_lossy().into_owned();
        export_backup(&backup_str, "hunter2").unwrap();

        // wrong password must fail cleanly
        assert!(import_backup(&backup_str, "wrong").is_err());

        // wipe the vault, restore from backup
        std::fs::remove_file(dir.join("connections.json")).unwrap();
        std::fs::remove_file(dir.join("snippets.json")).unwrap();
        let summary = import_backup(&backup_str, "hunter2").unwrap();
        assert_eq!(summary.connections, 2);
        assert_eq!(summary.snippets, 1);

        let restored = connections::load_all().unwrap();
        let beta = restored.iter().find(|c| c.name == "beta").unwrap();
        assert_eq!(beta.jump, "id-a", "native restore keeps jump ids");
        assert_eq!(load_snippets().unwrap()[0].command, "df -h");

        std::env::remove_var("REMOTEPAL_VAULT_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
