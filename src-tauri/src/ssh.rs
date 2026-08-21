//! SSH session management: one pump task per session owns the channel,
//! commands talk to it through an mpsc sender, and PTY output reaches
//! the frontend as base64 `ssh-data-{id}` events.
//!
//! Host keys are verified against ~/.remotepal/known_hosts (the same
//! file the PyQt app maintains). Unknown or changed keys fail the
//! connect with a structured error so the UI can show a trust dialog;
//! `trust_host_key` records the key and the frontend retries.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use russh::client;
use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConnectError {
    HostKeyUnknown {
        host: String,
        port: u16,
        fingerprint: String,
        key_openssh: String,
    },
    HostKeyChanged {
        host: String,
        port: u16,
        fingerprint: String,
        key_openssh: String,
    },
    Other {
        message: String,
    },
}

impl ConnectError {
    pub fn other(e: impl ToString) -> Self {
        ConnectError::Other {
            message: e.to_string(),
        }
    }
}

impl From<String> for ConnectError {
    fn from(message: String) -> Self {
        ConnectError::Other { message }
    }
}

pub enum TermCmd {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Default)]
pub struct SshSessions {
    counter: AtomicU32,
    senders: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<TermCmd>>>>,
}

fn known_hosts_file() -> Result<PathBuf, String> {
    Ok(crate::connections::vault_dir()?.join("known_hosts"))
}

/// Verifies the server key against the vault known_hosts file. On
/// anything but a match it parks a structured verdict in `issue` and
/// rejects, so `open_shell` can turn the generic handshake failure
/// into a useful error.
pub struct KnownHostsHandler {
    host: String,
    port: u16,
    issue: Arc<Mutex<Option<ConnectError>>>,
}

impl client::Handler for KnownHostsHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key: PublicKey = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::from(cert.public_key().clone())
            }
        };
        let mut issue = self.issue.lock().unwrap();
        let path = match known_hosts_file() {
            Ok(p) => p,
            Err(e) => {
                *issue = Some(ConnectError::Other { message: e });
                return Ok(false);
            }
        };
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let key_openssh = key.to_openssh().unwrap_or_default().trim().to_string();
        let verdict = if path.exists() {
            check_known_hosts_path(&self.host, self.port, &key, &path)
        } else {
            Ok(false) // no file yet: every host is unknown
        };
        match verdict {
            Ok(true) => Ok(true),
            Ok(false) => {
                *issue = Some(ConnectError::HostKeyUnknown {
                    host: self.host.clone(),
                    port: self.port,
                    fingerprint,
                    key_openssh,
                });
                Ok(false)
            }
            Err(russh::keys::Error::KeyChanged { .. }) => {
                *issue = Some(ConnectError::HostKeyChanged {
                    host: self.host.clone(),
                    port: self.port,
                    fingerprint,
                    key_openssh,
                });
                Ok(false)
            }
            Err(e) => {
                *issue = Some(ConnectError::Other {
                    message: format!("known_hosts error: {e}"),
                });
                Ok(false)
            }
        }
    }
}

/// Drop known_hosts lines for this host so a replacement key can be
/// learned. Only plain-text entries are matched; this app (and the
/// PyQt one) never writes hashed entries.
fn forget_host_entries(path: &PathBuf, host: &str, port: u16) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let pattern = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| {
            let Some(names) = line.split_whitespace().next() else {
                return true; // blank line
            };
            !names.split(',').any(|n| n == pattern)
        })
        .collect();
    std::fs::write(path, kept.join("\n") + "\n").map_err(|e| e.to_string())
}

pub fn trust_host_key_inner(host: &str, port: u16, key_openssh: &str) -> Result<(), String> {
    let key =
        PublicKey::from_openssh(key_openssh).map_err(|e| format!("bad host key: {e}"))?;
    let path = known_hosts_file()?;
    forget_host_entries(&path, host, port)?;
    learn_known_hosts_path(host, port, &key, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trust_host_key(host: String, port: u16, key_openssh: String) -> Result<(), String> {
    trust_host_key_inner(&host, port, &key_openssh)
}

/// Connect, authenticate, and open an interactive shell channel.
/// Tauri-free so the smoke-test example can drive it headlessly.
pub async fn open_shell(
    host: &str,
    port: u16,
    user: &str,
    password: Option<String>,
    key_path: Option<String>,
) -> Result<
    (
        client::Handle<KnownHostsHandler>,
        russh::Channel<client::Msg>,
    ),
    ConnectError,
> {
    let config = Arc::new(client::Config::default());
    let issue_slot = Arc::new(Mutex::new(None));
    let handler = KnownHostsHandler {
        host: host.to_string(),
        port,
        issue: Arc::clone(&issue_slot),
    };
    let mut session = match client::connect(config, (host, port), handler).await {
        Ok(session) => session,
        Err(e) => {
            if let Some(issue) = issue_slot.lock().unwrap().take() {
                return Err(issue);
            }
            return Err(ConnectError::other(e));
        }
    };

    let auth = match key_path.filter(|p| !p.trim().is_empty()) {
        Some(path) => {
            let key = russh::keys::load_secret_key(path.trim(), None)
                .map_err(|e| ConnectError::other(format!("cannot load key: {e}")))?;
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(ConnectError::other)?
                .flatten();
            session
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(ConnectError::other)?
        }
        None => session
            .authenticate_password(user, password.unwrap_or_default())
            .await
            .map_err(ConnectError::other)?,
    };
    if !auth.success() {
        return Err(ConnectError::other("Authentication failed"));
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(ConnectError::other)?;
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(ConnectError::other)?;
    channel
        .request_shell(false)
        .await
        .map_err(ConnectError::other)?;
    Ok((session, channel))
}

/// Open a shell and wire up the session pump; shared by ad-hoc and
/// saved-connection connects.
pub async fn start_session(
    app: AppHandle,
    sessions: &SshSessions,
    host: &str,
    port: u16,
    user: &str,
    password: Option<String>,
    key_path: Option<String>,
) -> Result<u32, ConnectError> {
    let (session, mut channel) = open_shell(host, port, user, password, key_path).await?;

    let id = sessions.counter.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel::<TermCmd>();
    sessions.senders.lock().unwrap().insert(id, tx);
    let senders = Arc::clone(&sessions.senders);

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(TermCmd::Data(bytes)) => {
                        if channel.data(&bytes[..]).await.is_err() {
                            break;
                        }
                    }
                    Some(TermCmd::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(TermCmd::Close) | None => break,
                },
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        let _ = app.emit(&format!("ssh-data-{id}"), B64.encode(&data[..]));
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        let _ = app.emit(&format!("ssh-data-{id}"), B64.encode(&data[..]));
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
            }
        }
        let _ = session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        senders.lock().unwrap().remove(&id);
        let _ = app.emit(&format!("ssh-closed-{id}"), ());
    });

    Ok(id)
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshSessions>,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<String>,
) -> Result<u32, ConnectError> {
    start_session(app, &state, &host, port, &user, password, key_path).await
}

fn send_cmd(state: &State<'_, SshSessions>, id: u32, cmd: TermCmd) -> Result<(), String> {
    let senders = state.senders.lock().unwrap();
    let tx = senders.get(&id).ok_or("no such session")?;
    tx.send(cmd).map_err(|_| "session closed".to_string())
}

#[tauri::command]
pub fn ssh_write(state: State<'_, SshSessions>, id: u32, data: String) -> Result<(), String> {
    send_cmd(&state, id, TermCmd::Data(data.into_bytes()))
}

#[tauri::command]
pub fn ssh_resize(
    state: State<'_, SshSessions>,
    id: u32,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    send_cmd(&state, id, TermCmd::Resize { cols, rows })
}

#[tauri::command]
pub fn ssh_disconnect(state: State<'_, SshSessions>, id: u32) -> Result<(), String> {
    // ignore unknown ids: the pump may already have cleaned up after itself
    let _ = send_cmd(&state, id, TermCmd::Close);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ67aMfdava0ARCxRfHgX0i7CuJSVXC6Fttj8I2fg+xA";
    const KEY_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKAImG70JQNvehB5oxvEa76XsLgphdNRQNBNDTLp9ZLS";

    #[test]
    fn changed_key_is_flagged_and_trust_replaces_it() {
        let _guard = crate::connections::test_env_lock().lock().unwrap();
        let dir = std::env::temp_dir().join(format!("remotepal-hk-{}", uuid::Uuid::new_v4()));
        std::env::set_var("REMOTEPAL_VAULT_DIR", &dir);

        let key_a = PublicKey::from_openssh(KEY_A).unwrap();
        let key_b = PublicKey::from_openssh(KEY_B).unwrap();

        trust_host_key_inner("example.com", 2222, KEY_A).unwrap();
        let path = known_hosts_file().unwrap();
        assert!(check_known_hosts_path("example.com", 2222, &key_a, &path).unwrap());

        // same host presents a different key -> KeyChanged
        assert!(matches!(
            check_known_hosts_path("example.com", 2222, &key_b, &path),
            Err(russh::keys::Error::KeyChanged { .. })
        ));

        // trusting the new key must REPLACE the old line, not append
        trust_host_key_inner("example.com", 2222, KEY_B).unwrap();
        assert!(check_known_hosts_path("example.com", 2222, &key_b, &path).unwrap());
        assert!(matches!(
            check_known_hosts_path("example.com", 2222, &key_a, &path),
            Err(russh::keys::Error::KeyChanged { .. })
        ));

        // other hosts' entries survive the replacement
        trust_host_key_inner("other.example.com", 22, KEY_A).unwrap();
        trust_host_key_inner("example.com", 2222, KEY_A).unwrap();
        assert!(check_known_hosts_path("other.example.com", 22, &key_a, &path).unwrap());

        std::env::remove_var("REMOTEPAL_VAULT_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
