//! Local port forwards (-L): a TCP listener per forward; every accepted
//! connection opens a direct-tcpip channel on the owning SSH session and
//! the two are piped with copy_bidirectional.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::ssh::SshSessions;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: u32,
    pub session_id: u32,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Default)]
pub struct Forwards {
    counter: AtomicU32,
    entries: Mutex<HashMap<u32, (ForwardInfo, oneshot::Sender<()>)>>,
}

/// Bind locally (port 0 picks a free one) and pump accepted
/// connections through the session. Dropping the returned sender (or
/// sending on it) stops the listener.
pub async fn start_forward(
    handle: Arc<russh::client::Handle<crate::ssh::KnownHostsHandler>>,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<(u16, oneshot::Sender<()>), String> {
    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| format!("cannot bind 127.0.0.1:{local_port}: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                accepted = listener.accept() => {
                    let Ok((mut tcp, peer)) = accepted else { break };
                    let handle = Arc::clone(&handle);
                    let host = remote_host.clone();
                    tauri::async_runtime::spawn(async move {
                        let channel = handle
                            .channel_open_direct_tcpip(
                                host,
                                remote_port as u32,
                                peer.ip().to_string(),
                                peer.port() as u32,
                            )
                            .await;
                        if let Ok(channel) = channel {
                            let mut stream = channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                        }
                    });
                }
            }
        }
    });

    Ok((bound, stop_tx))
}

pub async fn start_for_session(
    sessions: &SshSessions,
    forwards: &Forwards,
    session_id: u32,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<ForwardInfo, String> {
    let handle = sessions
        .maps
        .handles
        .lock()
        .unwrap()
        .get(&session_id)
        .cloned()
        .ok_or("no such session")?;
    let (bound, stop_tx) =
        start_forward(handle, local_port, remote_host.clone(), remote_port).await?;
    let id = forwards.counter.fetch_add(1, Ordering::Relaxed) + 1;
    let info = ForwardInfo {
        id,
        session_id,
        local_port: bound,
        remote_host,
        remote_port,
    };
    forwards
        .entries
        .lock()
        .unwrap()
        .insert(id, (info.clone(), stop_tx));
    Ok(info)
}

#[tauri::command]
pub async fn forward_start(
    sessions: State<'_, SshSessions>,
    forwards: State<'_, Forwards>,
    session_id: u32,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<ForwardInfo, String> {
    start_for_session(
        &sessions,
        &forwards,
        session_id,
        local_port,
        remote_host,
        remote_port,
    )
    .await
}

/// Pin or unpin a forward on a saved connection; pinned forwards
/// auto-start every time that connection opens.
#[tauri::command]
pub fn forward_pin(
    lock: State<'_, crate::connections::StoreLock>,
    conn_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    pinned: bool,
) -> Result<(), String> {
    let _guard = lock.0.lock().unwrap();
    let mut list = crate::connections::load_all()?;
    let conn = list
        .iter_mut()
        .find(|c| c.id == conn_id)
        .ok_or("saved connection not found")?;
    let entry = crate::connections::SavedForward {
        local_port,
        remote_host,
        remote_port,
    };
    conn.forwards.retain(|f| *f != entry);
    if pinned {
        conn.forwards.push(entry);
    }
    crate::connections::save_all(&list)
}

#[tauri::command]
pub fn forward_stop(forwards: State<'_, Forwards>, id: u32) -> Result<(), String> {
    // dropping the sender ends the listener's select loop
    forwards.entries.lock().unwrap().remove(&id);
    Ok(())
}

#[tauri::command]
pub fn forwards_list(
    sessions: State<'_, SshSessions>,
    forwards: State<'_, Forwards>,
    session_id: u32,
) -> Result<Vec<ForwardInfo>, String> {
    let alive: Vec<u32> = sessions
        .maps
        .senders
        .lock()
        .unwrap()
        .keys()
        .copied()
        .collect();
    let mut entries = forwards.entries.lock().unwrap();
    // forwards of dead sessions: dropping their senders stops them
    entries.retain(|_, (info, _)| alive.contains(&info.session_id));
    Ok(entries
        .values()
        .map(|(info, _)| info.clone())
        .filter(|info| info.session_id == session_id)
        .collect())
}
