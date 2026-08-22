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

/// Single-quote a path for the remote shell. Names come from a remote
/// listing, so they are untrusted input to a command line.
fn sh_quote(s: &str) -> String {
    // close the quote, add an escaped one, reopen: ' -> '\''
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Copy (or move) paths into `dest_dir` on the same host. This runs `cp`
/// / `mv` over the session rather than streaming the bytes here and back,
/// so the data never leaves the server.
#[tauri::command]
pub async fn sftp_copy(
    sessions: State<'_, SshSessions>,
    id: u32,
    sources: Vec<String>,
    dest_dir: String,
    move_items: bool,
) -> Result<u32, String> {
    let handle = sessions
        .maps
        .handles
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("no such session")?;

    let mut done = 0u32;
    for src in &sources {
        // pasting a directory inside itself would recurse
        if dest_dir == *src || dest_dir.starts_with(&format!("{src}/")) {
            return Err(format!("cannot copy {src} into itself"));
        }
        // -R -p rather than -a: BSD/macOS hosts have no -a
        let verb = if move_items { "mv" } else { "cp -R -p" };
        let cmd = format!(
            "{verb} -- {} {}",
            sh_quote(src),
            sh_quote(&dest_dir)
        );
        let cap = crate::ssh::exec_capture_capped(
            &handle,
            &cmd,
            Duration::from_secs(120),
            8192,
        )
        .await?;
        if cap.exit_code != 0 {
            return Err(if cap.stderr.is_empty() {
                format!("copy failed (exit {})", cap.exit_code)
            } else {
                cap.stderr
            });
        }
        done += 1;
    }
    Ok(done)
}

/// Compress paths in `dir` into one archive, on the server. `format` is
/// "zip" or "tar.gz"; zip needs the zip binary installed, tar is present
/// almost everywhere, so both are offered rather than guessed at.
#[tauri::command]
pub async fn sftp_archive(
    sessions: State<'_, SshSessions>,
    id: u32,
    dir: String,
    names: Vec<String>,
    archive: String,
    format: String,
) -> Result<String, String> {
    if names.is_empty() {
        return Err("nothing selected".to_string());
    }
    let handle = sessions
        .maps
        .handles
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("no such session")?;

    let quoted: Vec<String> = names.iter().map(|n| sh_quote(n)).collect();
    let (name, tool) = match format.as_str() {
        "zip" => (format!("{archive}.zip"), "zip -r -q"),
        _ => (format!("{archive}.tar.gz"), "tar -czf"),
    };
    let cmd = format!(
        "cd {} && {tool} {} {}",
        sh_quote(&dir),
        sh_quote(&name),
        quoted.join(" ")
    );

    let cap = crate::ssh::exec_capture_capped(
        &handle,
        &cmd,
        Duration::from_secs(600),
        8192,
    )
    .await?;
    if cap.exit_code != 0 {
        let hint = if format == "zip" && cap.stderr.contains("not found") {
            " — zip is not installed on this host, try tar.gz"
        } else {
            ""
        };
        return Err(format!(
            "{}{hint}",
            if cap.stderr.is_empty() {
                format!("archiving failed (exit {})", cap.exit_code)
            } else {
                cap.stderr
            }
        ));
    }
    Ok(name)
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

// ------------------------------------------------------- folder sync

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    uploaded: usize,
    deleted: usize,
    skipped: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncProgress<'a> {
    transfer_id: &'a str,
    current: &'a str,
    index: usize,
    total: usize,
}

pub(crate) type FileMap = std::collections::HashMap<String, (u64, i64)>;

pub(crate) fn collect_local(root: &std::path::Path) -> Result<FileMap, String> {
    let mut files = FileMap::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            if meta.is_dir() {
                stack.push((entry.path(), child_rel));
            } else if meta.is_file() {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                files.insert(child_rel, (meta.len(), mtime));
            }
        }
    }
    Ok(files)
}

async fn collect_remote(
    sftp: &SftpSession,
    root: &str,
) -> Result<(FileMap, Vec<String>), String> {
    let mut files = FileMap::new();
    let mut dirs = Vec::new();
    let mut stack = vec![(root.to_string(), String::new())];
    while let Some((rpath, rel)) = stack.pop() {
        let entries = sftp.read_dir(&rpath).await.map_err(|e| e.to_string())?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let child_path = format!("{}/{}", rpath.trim_end_matches('/'), name);
            let meta = entry.metadata();
            if meta.is_dir() {
                dirs.push(child_rel.clone());
                stack.push((child_path, child_rel));
            } else {
                files.insert(
                    child_rel,
                    (meta.size.unwrap_or(0), meta.mtime.unwrap_or(0) as i64),
                );
            }
        }
    }
    Ok((files, dirs))
}

/// Relative paths needing upload: missing remotely, size differs, or
/// local mtime newer (+1s fudge: filesystems differ in granularity).
pub(crate) fn plan_copies(local: &FileMap, remote: &FileMap) -> Vec<String> {
    let mut to_copy: Vec<String> = local
        .iter()
        .filter(|(rel, (size, mtime))| match remote.get(*rel) {
            None => true,
            Some((rsize, rmtime)) => size != rsize || *mtime > rmtime + 1,
        })
        .map(|(rel, _)| rel.clone())
        .collect();
    to_copy.sort();
    to_copy
}

/// Push-sync a local directory into the remote one: upload missing and
/// changed files (size differs, or local mtime newer with a +1s
/// fudge), optionally delete remote extras (mirror).
#[tauri::command]
pub async fn sftp_sync(
    app: AppHandle,
    state: State<'_, SshSessions>,
    id: u32,
    local_dir: String,
    remote_dir: String,
    delete_extra: bool,
    transfer_id: String,
) -> Result<SyncSummary, String> {
    let sftp = sftp_for(&state, id).await?;
    let local_root = std::path::PathBuf::from(&local_dir);
    if !local_root.is_dir() {
        return Err(format!("{local_dir} is not a directory"));
    }
    let local = collect_local(&local_root)?;
    let (remote, remote_dirs) = collect_remote(&sftp, &remote_dir).await?;

    let to_copy = plan_copies(&local, &remote);

    let total = to_copy.len();
    let mut created: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (index, rel) in to_copy.iter().enumerate() {
        let _ = app.emit(
            "sync-progress",
            SyncProgress {
                transfer_id: &transfer_id,
                current: rel,
                index,
                total,
            },
        );
        // ensure parent directories exist remotely
        let parts: Vec<&str> = rel.split('/').collect();
        let mut dir = remote_dir.trim_end_matches('/').to_string();
        for part in &parts[..parts.len() - 1] {
            dir = format!("{dir}/{part}");
            if created.insert(dir.clone()) {
                let _ = sftp.create_dir(&dir).await; // may already exist
            }
        }
        let local_path = local_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), rel);
        copy_local_to_remote(&sftp, &local_path, &remote_path)
            .await
            .map_err(|e| format!("{rel}: {e}"))?;
    }

    let mut deleted = 0;
    if delete_extra {
        let mut extra_files: Vec<&String> =
            remote.keys().filter(|rel| !local.contains_key(*rel)).collect();
        extra_files.sort();
        for rel in extra_files {
            let path = format!("{}/{}", remote_dir.trim_end_matches('/'), rel);
            sftp.remove_file(&path)
                .await
                .map_err(|e| format!("delete {rel}: {e}"))?;
            deleted += 1;
        }
        // extra dirs, deepest first
        let local_dirs: std::collections::HashSet<String> = local
            .keys()
            .flat_map(|rel| {
                let parts: Vec<&str> = rel.split('/').collect();
                (1..parts.len())
                    .map(|i| parts[..i].join("/"))
                    .collect::<Vec<_>>()
            })
            .collect();
        let mut extra_dirs: Vec<&String> = remote_dirs
            .iter()
            .filter(|d| !local_dirs.contains(*d))
            .collect();
        extra_dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
        for rel in extra_dirs {
            let path = format!("{}/{}", remote_dir.trim_end_matches('/'), rel);
            let _ = sftp.remove_dir(&path).await; // only removes if empty
        }
    }

    let _ = app.emit(
        "sync-progress",
        SyncProgress {
            transfer_id: &transfer_id,
            current: "done",
            index: total,
            total,
        },
    );
    Ok(SyncSummary {
        uploaded: total,
        deleted,
        skipped: local.len() - total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_awkward_names() {
        // ordinary name
        assert_eq!(sh_quote("/tmp/notes.txt"), "'/tmp/notes.txt'");
        // spaces need no special handling inside single quotes
        assert_eq!(sh_quote("/tmp/my file"), "'/tmp/my file'");
        // a quote in the name must not end the quoting — this is what
        // stops a filename from becoming part of the command
        assert_eq!(sh_quote("/tmp/it's"), r"'/tmp/it'\''s'");
        // characters the shell would otherwise act on stay literal
        assert_eq!(sh_quote("/tmp/a;rm -rf b"), "'/tmp/a;rm -rf b'");
        assert_eq!(sh_quote("/tmp/$(whoami)"), "'/tmp/$(whoami)'");
        assert_eq!(sh_quote("/tmp/`id`"), "'/tmp/`id`'");
    }

    #[test]
    fn plan_copies_missing_changed_and_fudge() {
        let mut local = FileMap::new();
        local.insert("same.txt".into(), (10, 100));
        local.insert("bigger.txt".into(), (20, 100));
        local.insert("newer.txt".into(), (10, 200));
        local.insert("missing.txt".into(), (5, 100));
        local.insert("within-fudge.txt".into(), (10, 101));
        let mut remote = FileMap::new();
        remote.insert("same.txt".into(), (10, 100));
        remote.insert("bigger.txt".into(), (10, 100));
        remote.insert("newer.txt".into(), (10, 100));
        remote.insert("within-fudge.txt".into(), (10, 100));
        remote.insert("extra.txt".into(), (1, 1));
        assert_eq!(
            plan_copies(&local, &remote),
            vec!["bigger.txt", "missing.txt", "newer.txt"]
        );
    }
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
