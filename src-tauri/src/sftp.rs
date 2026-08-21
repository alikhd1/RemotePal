//! SFTP browser backend: one lazily-opened SFTP subsystem per SSH
//! session, file listings, and transfers with progress events
//! (`sftp-progress` payload: { transferId, done, total }).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::{SessionMaps, SshSessions};

/// Live edit-on-save watchers, keyed by SSH session id. Dropping a
/// watcher stops it; entries for dead sessions are pruned on the next
/// sftp_edit call.
#[derive(Default)]
pub struct EditState(pub Mutex<HashMap<u32, Vec<notify::RecommendedWatcher>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    name: String,
    is_dir: bool,
    size: u64,
    mtime: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    transfer_id: &'a str,
    done: u64,
    total: u64,
}

const PROGRESS_STEP: u64 = 256 * 1024;

async fn sftp_for(sessions: &SshSessions, id: u32) -> Result<Arc<SftpSession>, String> {
    sftp_for_maps(&sessions.maps, id).await
}

pub(crate) async fn sftp_for_maps(
    maps: &SessionMaps,
    id: u32,
) -> Result<Arc<SftpSession>, String> {
    if let Some(s) = maps.sftp.lock().unwrap().get(&id) {
        return Ok(Arc::clone(s));
    }
    let handle = maps
        .handles
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("no such session")?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("server has no SFTP subsystem: {e}"))?;
    let sftp = Arc::new(
        SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| e.to_string())?,
    );
    maps.sftp.lock().unwrap().insert(id, Arc::clone(&sftp));
    Ok(sftp)
}

async fn copy_remote_to_local(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &PathBuf,
) -> Result<(), String> {
    let mut remote = sftp.open(remote_path).await.map_err(|e| e.to_string())?;
    let mut local = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| e.to_string())?;
    tokio::io::copy(&mut remote, &mut local)
        .await
        .map_err(|e| e.to_string())?;
    local.flush().await.map_err(|e| e.to_string())?;
    let _ = remote.shutdown().await;
    Ok(())
}

async fn copy_local_to_remote(
    sftp: &SftpSession,
    local_path: &PathBuf,
    remote_path: &str,
) -> Result<(), String> {
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut remote = sftp.create(remote_path).await.map_err(|e| e.to_string())?;
    tokio::io::copy(&mut local, &mut remote)
        .await
        .map_err(|e| e.to_string())?;
    remote.flush().await.map_err(|e| e.to_string())?;
    remote.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditEvent {
    session_id: u32,
    name: String,
    message: Option<String>,
}

/// Download the file to a temp dir, open it in the default local app,
/// and re-upload (debounced) every time it changes on disk.
#[tauri::command]
pub async fn sftp_edit(
    app: AppHandle,
    state: State<'_, SshSessions>,
    edits: State<'_, EditState>,
    id: u32,
    remote_path: String,
) -> Result<String, String> {
    let sftp = sftp_for(&state, id).await?;
    let name = remote_path
        .rsplit('/')
        .next()
        .unwrap_or("file")
        .to_string();
    let dir = std::env::temp_dir()
        .join("remotepal-edit")
        .join(id.to_string());
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let local = dir.join(&name);
    copy_remote_to_local(&sftp, &remote_path, &local).await?;

    tauri_plugin_opener::open_path(&local, None::<&str>)
        .map_err(|e| format!("cannot open editor: {e}"))?;

    // Watch the parent dir: editors replace files on save, which kills
    // a watch placed on the file itself.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let watch_name = name.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let relevant = matches!(
                event.kind,
                notify::EventKind::Modify(_) | notify::EventKind::Create(_)
            ) && event
                .paths
                .iter()
                .any(|p| p.file_name().is_some_and(|f| f == watch_name.as_str()));
            if relevant {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let maps = Arc::clone(&state.maps);
    let event_name = name.clone();
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            // debounce: editors emit bursts of events per save
            while let Ok(Some(_)) =
                tokio::time::timeout(Duration::from_millis(400), rx.recv()).await
            {}
            let result = match sftp_for_maps(&maps, id).await {
                Ok(sftp) => {
                    copy_local_to_remote(&sftp, &dir.join(&event_name), &remote_path).await
                }
                Err(e) => Err(e),
            };
            let (event, message) = match result {
                Ok(()) => ("sftp-edit-uploaded", None),
                Err(e) => ("sftp-edit-error", Some(e)),
            };
            let _ = app.emit(
                event,
                EditEvent {
                    session_id: id,
                    name: event_name.clone(),
                    message,
                },
            );
        }
    });

    // keep the watcher alive; prune watchers of dead sessions
    let mut map = edits.0.lock().unwrap();
    let alive: Vec<u32> = state.maps.senders.lock().unwrap().keys().copied().collect();
    map.retain(|sid, _| alive.contains(sid));
    map.entry(id).or_default().push(watcher);
    Ok(local.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, SshSessions>, id: u32) -> Result<String, String> {
    let sftp = sftp_for(&state, id).await?;
    sftp.canonicalize(".").await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SshSessions>,
    id: u32,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let sftp = sftp_for(&state, id).await?;
    let dir = sftp.read_dir(&path).await.map_err(|e| e.to_string())?;
    Ok(dir
        .filter(|e| e.file_name() != "." && e.file_name() != "..")
        .map(|e| {
            let meta = e.metadata();
            SftpEntry {
                name: e.file_name(),
                is_dir: meta.is_dir(),
                size: meta.size.unwrap_or(0),
                mtime: meta.mtime.unwrap_or(0),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, SshSessions>,
    id: u32,
    path: String,
) -> Result<(), String> {
    let sftp = sftp_for(&state, id).await?;
    sftp.create_dir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SshSessions>,
    id: u32,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = sftp_for(&state, id).await?;
    sftp.rename(&from, &to).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, SshSessions>,
    id: u32,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let sftp = sftp_for(&state, id).await?;
    if is_dir {
        sftp.remove_dir(&path).await.map_err(|e| e.to_string())
    } else {
        sftp.remove_file(&path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, SshSessions>,
    id: u32,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<u64, String> {
    let sftp = sftp_for(&state, id).await?;
    let total = sftp
        .metadata(&remote_path)
        .await
        .ok()
        .and_then(|m| m.size)
        .unwrap_or(0);
    let mut remote = sftp.open(&remote_path).await.map_err(|e| e.to_string())?;
    let mut local = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 32 * 1024];
    let mut done: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let n = remote.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        local.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last_emit >= PROGRESS_STEP {
            last_emit = done;
            let _ = app.emit(
                "sftp-progress",
                Progress {
                    transfer_id: &transfer_id,
                    done,
                    total: total.max(done),
                },
            );
        }
    }
    local.flush().await.map_err(|e| e.to_string())?;
    // close the remote handle promptly: Windows-hosted servers refuse
    // to delete/rename files whose handles are still open
    let _ = remote.shutdown().await;
    let _ = app.emit(
        "sftp-progress",
        Progress {
            transfer_id: &transfer_id,
            done,
            total: done,
        },
    );
    Ok(done)
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SshSessions>,
    id: u32,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<u64, String> {
    let sftp = sftp_for(&state, id).await?;
    let meta = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("directories cannot be uploaded (yet) — drop files instead".into());
    }
    let mut local = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| e.to_string())?;
    let total = meta.len();
    let mut remote = sftp.create(&remote_path).await.map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 32 * 1024];
    let mut done: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let n = local.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last_emit >= PROGRESS_STEP {
            last_emit = done;
            let _ = app.emit(
                "sftp-progress",
                Progress {
                    transfer_id: &transfer_id,
                    done,
                    total: total.max(done),
                },
            );
        }
    }
    remote.flush().await.map_err(|e| e.to_string())?;
    remote.shutdown().await.map_err(|e| e.to_string())?;
    let _ = app.emit(
        "sftp-progress",
        Progress {
            transfer_id: &transfer_id,
            done,
            total: done,
        },
    );
    Ok(done)
}
