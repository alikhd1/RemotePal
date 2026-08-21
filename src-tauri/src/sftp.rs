//! SFTP browser backend: one lazily-opened SFTP subsystem per SSH
//! session, file listings, and transfers with progress events
//! (`sftp-progress` payload: { transferId, done, total }).

use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::SshSessions;

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
    if let Some(s) = sessions.maps.sftp.lock().unwrap().get(&id) {
        return Ok(Arc::clone(s));
    }
    let handle = sessions
        .maps
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
    sessions
        .maps
        .sftp
        .lock()
        .unwrap()
        .insert(id, Arc::clone(&sftp));
    Ok(sftp)
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
    let mut local = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| e.to_string())?;
    let total = local
        .metadata()
        .await
        .map(|m| m.len())
        .unwrap_or(0);
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
