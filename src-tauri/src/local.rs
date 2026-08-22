//! Local shell sessions. A PTY (ConPTY on Windows, forkpty elsewhere) runs
//! the user's shell; output reaches the frontend as base64 `local-data-{id}`
//! events and input arrives through `local_write`, mirroring the SSH pump in
//! `ssh.rs` so the same xterm frontend can drive either.
//!
//! portable-pty is blocking, so each session gets a reader thread rather
//! than living on the async runtime.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

struct LocalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct LocalSessions {
    counter: AtomicU32,
    sessions: Mutex<HashMap<u32, LocalSession>>,
}

/// The shell to launch: an explicit override, else the platform default.
fn default_shell() -> String {
    if let Ok(s) = std::env::var("REMOTEPAL_SHELL") {
        if !s.is_empty() {
            return s;
        }
    }
    #[cfg(windows)]
    {
        // prefer PowerShell, falling back to whatever COMSPEC points at
        for candidate in ["pwsh.exe", "powershell.exe"] {
            if which_exists(candidate) {
                return candidate.to_string();
            }
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[cfg(windows)]
fn which_exists(exe: &str) -> bool {
    std::env::var("PATH")
        .map(|path| {
            std::env::split_paths(&path).any(|dir| dir.join(exe).is_file())
        })
        .unwrap_or(false)
}

/// Open a local shell and start pumping its output to the frontend.
#[tauri::command]
pub fn local_open(
    app: AppHandle,
    state: State<'_, LocalSessions>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
) -> Result<u32, String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("cannot open a local terminal: {e}"))?;

    let program = shell.filter(|s| !s.is_empty()).unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&program);
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("cannot start {program}: {e}"))?;
    // the slave handle must go away or the PTY never reports EOF
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("cannot read from the shell: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("cannot write to the shell: {e}"))?;

    let id = state.counter.fetch_add(1, Ordering::Relaxed) + 1;
    state.sessions.lock().unwrap().insert(
        id,
        LocalSession {
            master: pair.master,
            writer,
            child,
        },
    );

    // blocking reads live on their own thread
    let app_for_reader = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app_for_reader
                        .emit(&format!("local-data-{id}"), B64.encode(&buf[..n]));
                }
            }
        }
        let _ = app_for_reader.emit(&format!("local-closed-{id}"), ());
    });

    Ok(id)
}

#[tauri::command]
pub fn local_write(state: State<'_, LocalSessions>, id: u32, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().unwrap();
    let session = map.get_mut(&id).ok_or("no such local session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_resize(
    state: State<'_, LocalSessions>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.sessions.lock().unwrap();
    let session = map.get(&id).ok_or("no such local session")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_close(state: State<'_, LocalSessions>, id: u32) -> Result<(), String> {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

/// What this machine is, for the local terminal's info strip: an OS slug
/// the frontend has an icon for, plus who and where we are running.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInfo {
    pub os: String,
    pub user: String,
    pub host: String,
    pub shell: String,
}

#[tauri::command]
pub fn local_info() -> LocalInfo {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "freebsd") {
        "freebsd"
    } else {
        "linux"
    };

    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "local".to_string());
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "this device".to_string());

    // just the program name; the full path is noise in a one-line strip
    let full = default_shell();
    let shell = full
        .rsplit(|c| c == '/' || c == std::path::MAIN_SEPARATOR)
        .next()
        .unwrap_or(&full)
        .trim_end_matches(".exe")
        .to_string();

    LocalInfo {
        os: os.to_string(),
        user,
        host,
        shell,
    }
}

/// Shells worth offering in the UI; the first entry is the default.
#[tauri::command]
pub fn local_shells() -> Vec<String> {
    let mut out = vec![default_shell()];
    #[cfg(windows)]
    {
        for candidate in ["powershell.exe", "cmd.exe", "pwsh.exe", "bash.exe"] {
            if which_exists(candidate) && !out.iter().any(|s| s == candidate) {
                out.push(candidate.to_string());
            }
        }
    }
    #[cfg(not(windows))]
    {
        for candidate in ["/bin/bash", "/bin/zsh", "/bin/sh", "/usr/bin/fish"] {
            if std::path::Path::new(candidate).exists()
                && !out.iter().any(|s| s == candidate)
            {
                out.push(candidate.to_string());
            }
        }
    }
    out
}

/// Kill every local shell — used when the app shuts down.
pub fn close_all(state: &LocalSessions) {
    let mut map = state.sessions.lock().unwrap();
    for (_, mut session) in map.drain() {
        let _ = session.child.kill();
    }
}

pub type SharedLocal = Arc<LocalSessions>;
