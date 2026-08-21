//! SSH session management: one pump task per session owns the channel,
//! commands talk to it through an mpsc sender, and PTY output reaches
//! the frontend as base64 `ssh-data-{id}` events.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use russh::client;
use russh::keys::PrivateKeyWithHashAlg;
use russh::{ChannelMsg, Disconnect};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

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

pub struct AcceptingHandler;

impl client::Handler for AcceptingHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // TODO: verify against known_hosts before this ships anywhere
        Ok(true)
    }
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
        client::Handle<AcceptingHandler>,
        russh::Channel<client::Msg>,
    ),
    String,
> {
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (host, port), AcceptingHandler)
        .await
        .map_err(|e| e.to_string())?;

    let auth = match key_path.filter(|p| !p.trim().is_empty()) {
        Some(path) => {
            let key = russh::keys::load_secret_key(path.trim(), None)
                .map_err(|e| format!("cannot load key: {e}"))?;
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| e.to_string())?
                .flatten();
            session
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| e.to_string())?
        }
        None => session
            .authenticate_password(user, password.unwrap_or_default())
            .await
            .map_err(|e| e.to_string())?,
    };
    if !auth.success() {
        return Err("Authentication failed".into());
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| e.to_string())?;
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
) -> Result<u32, String> {
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
) -> Result<u32, String> {
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
