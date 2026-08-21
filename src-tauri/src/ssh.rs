//! SSH session management: one pump task per session owns the channel,
//! commands talk to it through an mpsc sender, and PTY output reaches
//! the frontend as base64 `ssh-data-{id}` events.
//!
//! Connections are described as a chain of ConnectSpecs (jump hosts
//! first, target last); every hop after the first runs over a
//! direct-tcpip channel of the previous one. Host keys are verified
//! per hop against ~/.remotepal/known_hosts (shared with
//! RemotePal-python); unknown or changed keys fail the connect with a
//! structured error so the UI can show a trust dialog.

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

/// One hop of a connection chain.
#[derive(Debug, Clone)]
pub struct ConnectSpec {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub agent_forward: bool,
}

pub enum TermCmd {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

pub type SshHandle = client::Handle<KnownHostsHandler>;

/// Everything keyed by session id. The pump task owns a clone of the
/// Arc so it can clean up after itself; SFTP sessions are opened lazily
/// on the stored SSH handle (the chain's final hop).
#[derive(Default)]
pub struct SessionMaps {
    pub senders: Mutex<HashMap<u32, mpsc::UnboundedSender<TermCmd>>>,
    pub handles: Mutex<HashMap<u32, Arc<SshHandle>>>,
    pub sftp: Mutex<HashMap<u32, Arc<russh_sftp::client::SftpSession>>>,
    /// connect specs per session, kept for Reconnect (dropped on close
    /// only if the session ended by explicit disconnect, so a dead
    /// session's specs survive for the banner's Reconnect button)
    pub specs: Mutex<HashMap<u32, Vec<ConnectSpec>>>,
}

#[derive(Default)]
pub struct SshSessions {
    counter: AtomicU32,
    pub maps: Arc<SessionMaps>,
}

fn known_hosts_file() -> Result<PathBuf, String> {
    Ok(crate::connections::vault_dir()?.join("known_hosts"))
}

/// Verifies the server key against the vault known_hosts file. On
/// anything but a match it parks a structured verdict in `issue` and
/// rejects, so the connect can turn the generic handshake failure
/// into a useful error.
pub struct KnownHostsHandler {
    host: String,
    port: u16,
    agent_forward: bool,
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

    /// Server-opened agent channels are piped to the local OpenSSH
    /// agent's named pipe — only when this hop asked for forwarding.
    fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let allow = self.agent_forward;
        async move {
            if !allow {
                drop(reply); // dropping rejects the open
                return Ok(());
            }
            reply.accept().await;
            tauri::async_runtime::spawn(async move {
                #[cfg(windows)]
                {
                    let pipe = tokio::net::windows::named_pipe::ClientOptions::new()
                        .open(r"\\.\pipe\openssh-ssh-agent");
                    if let Ok(mut pipe) = pipe {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut stream, &mut pipe).await;
                    }
                }
                #[cfg(not(windows))]
                {
                    if let Ok(path) = std::env::var("SSH_AUTH_SOCK") {
                        if let Ok(mut sock) = tokio::net::UnixStream::connect(path).await {
                            let mut stream = channel.into_stream();
                            let _ =
                                tokio::io::copy_bidirectional(&mut stream, &mut sock).await;
                        }
                    }
                }
            });
            Ok(())
        }
    }
}

/// Drop known_hosts lines for this host so a replacement key can be
/// learned. Only plain-text entries are matched; RemotePal never
/// writes hashed entries.
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

async fn authenticate(session: &mut SshHandle, spec: &ConnectSpec) -> Result<(), ConnectError> {
    let auth = match spec.key_path.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(path) => {
            let key = russh::keys::load_secret_key(path.trim(), None)
                .map_err(|e| ConnectError::other(format!("cannot load key: {e}")))?;
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(ConnectError::other)?
                .flatten();
            session
                .authenticate_publickey(
                    &spec.user,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(ConnectError::other)?
        }
        None => session
            .authenticate_password(&spec.user, spec.password.clone().unwrap_or_default())
            .await
            .map_err(ConnectError::other)?,
    };
    if !auth.success() {
        return Err(ConnectError::other(format!(
            "Authentication failed for {}@{}",
            spec.user, spec.host
        )));
    }
    Ok(())
}

/// Connect one hop: directly, or through a direct-tcpip channel of the
/// previous hop.
async fn connect_one(
    spec: &ConnectSpec,
    via: Option<&Arc<SshHandle>>,
) -> Result<SshHandle, ConnectError> {
    let config = Arc::new(client::Config::default());
    let issue_slot = Arc::new(Mutex::new(None));
    let handler = KnownHostsHandler {
        host: spec.host.clone(),
        port: spec.port,
        agent_forward: spec.agent_forward,
        issue: Arc::clone(&issue_slot),
    };
    let attempt = match via {
        None => client::connect(config, (spec.host.as_str(), spec.port), handler).await,
        Some(prev) => {
            let channel = prev
                .channel_open_direct_tcpip(
                    spec.host.clone(),
                    spec.port as u32,
                    "127.0.0.1".to_string(),
                    0,
                )
                .await
                .map_err(|e| {
                    ConnectError::other(format!(
                        "jump tunnel to {}:{} failed: {e}",
                        spec.host, spec.port
                    ))
                })?;
            client::connect_stream(config, channel.into_stream(), handler).await
        }
    };
    let mut session = match attempt {
        Ok(session) => session,
        Err(e) => {
            if let Some(issue) = issue_slot.lock().unwrap().take() {
                return Err(issue);
            }
            return Err(ConnectError::other(e));
        }
    };
    authenticate(&mut session, spec).await?;
    Ok(session)
}

/// Connect every hop (jumps first). The returned handles must stay
/// alive as long as anything runs over the final one.
pub async fn connect_chain(specs: &[ConnectSpec]) -> Result<Vec<Arc<SshHandle>>, ConnectError> {
    if specs.is_empty() {
        return Err(ConnectError::other("empty connection chain"));
    }
    let mut chain: Vec<Arc<SshHandle>> = Vec::with_capacity(specs.len());
    for spec in specs {
        let session = connect_one(spec, chain.last()).await?;
        chain.push(Arc::new(session));
    }
    Ok(chain)
}

/// Captured result of a one-off command run over a dedicated exec channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecCapture {
    pub exit_code: u32,
    pub stdout: String,
    pub stderr: String,
    /// output was clipped at the combined byte cap
    pub truncated: bool,
}

/// Core exec: run one command over a fresh channel, capturing both
/// streams, with a configurable timeout and a combined byte cap. Bytes
/// are collected raw and decoded once at the end (so a multibyte char
/// split across chunks isn't corrupted). Output is `trim_end`ed only.
pub async fn exec_capture_capped(
    handle: &SshHandle,
    command: &str,
    timeout: std::time::Duration,
    max_bytes: usize,
) -> Result<ExecCapture, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel.exec(true, command).await.map_err(|e| e.to_string())?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut status: Option<u32> = None;
    let mut truncated = false;
    let deadline = tokio::time::Instant::now() + timeout;

    // Append `data` to `buf`, honoring a cap on total(stdout)+total(stderr).
    let append = |buf: &mut Vec<u8>, other_len: usize, data: &[u8], truncated: &mut bool| {
        let used = buf.len() + other_len;
        if used >= max_bytes {
            *truncated = true;
            return;
        }
        let room = max_bytes - used;
        if data.len() > room {
            buf.extend_from_slice(&data[..room]);
            *truncated = true;
        } else {
            buf.extend_from_slice(data);
        }
    };

    loop {
        let msg = tokio::time::timeout_at(deadline, channel.wait())
            .await
            .map_err(|_| "remote command timed out".to_string())?;
        match msg {
            Some(ChannelMsg::Data { ref data }) => {
                let n = stderr.len();
                append(&mut stdout, n, data, &mut truncated);
            }
            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                let n = stdout.len();
                append(&mut stderr, n, data, &mut truncated);
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
            Some(ChannelMsg::Close) if status.is_some() => break,
            None => break,
            _ => {}
        }
        if truncated {
            // stop the remote streaming more than we'll keep
            let _ = channel.close().await;
            break;
        }
    }

    Ok(ExecCapture {
        exit_code: status.unwrap_or(255),
        stdout: String::from_utf8_lossy(&stdout).trim_end().to_string(),
        stderr: String::from_utf8_lossy(&stderr).trim_end().to_string(),
        truncated,
    })
}

/// Run one command on a session, returning (exit status, stdout, stderr).
/// Fully trimmed, 20s timeout, no size cap — the shape existing callers
/// (`exec_on`, OS detection) expect.
pub async fn exec_capture(
    handle: &SshHandle,
    command: &str,
) -> Result<(u32, String, String), String> {
    let c = exec_capture_capped(
        handle,
        command,
        std::time::Duration::from_secs(20),
        usize::MAX,
    )
    .await?;
    Ok((c.exit_code, c.stdout.trim().to_string(), c.stderr.trim().to_string()))
}

/// Run one command on a session, returning (exit status, stderr).
pub async fn exec_on(handle: &SshHandle, command: &str) -> Result<(u32, String), String> {
    let (status, _stdout, stderr) = exec_capture(handle, command).await?;
    Ok((status, stderr))
}

/// A raw snapshot of a Linux server's vitals, read from /proc + df. The
/// frontend info strip turns consecutive snapshots into CPU% and network
/// rates and formats the rest. Fields are 0 when unavailable (e.g. a
/// non-Linux host with no /proc), which the frontend treats as "hide".
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStats {
    pub cores: u32,
    pub load1: f64,
    /// total and idle CPU jiffies (idle includes iowait)
    pub cpu_total: u64,
    pub cpu_idle: u64,
    pub mem_total_kb: u64,
    pub mem_avail_kb: u64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub uptime_secs: f64,
}

/// One cheap snapshot: no sleeps, so it returns fast; the frontend derives
/// rates/percentages from the delta between polls.
const STATS_CMD: &str = r#"nproc 2>/dev/null | awk '{print "cores", $1}'
awk '/^cpu /{print "cpu", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat 2>/dev/null
awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{print "mem", t, a}' /proc/meminfo 2>/dev/null
df -kP / 2>/dev/null | awk 'NR==2{print "disk", $2, $3}'
awk 'NR>2 && $1!="lo:"{rx+=$2; tx+=$10}END{print "net", rx, tx}' /proc/net/dev 2>/dev/null
awk '{print "load", $1}' /proc/loadavg 2>/dev/null
awk '{print "up", $1}' /proc/uptime 2>/dev/null"#;

fn next_num<T: std::str::FromStr>(it: &mut std::str::SplitWhitespace<'_>) -> Option<T> {
    it.next().and_then(|v| v.parse().ok())
}

fn parse_stats(out: &str) -> ServerStats {
    let mut s = ServerStats::default();
    for line in out.lines() {
        let mut it = line.split_whitespace();
        match it.next() {
            Some("cores") => s.cores = next_num(&mut it).unwrap_or(0),
            Some("cpu") => {
                s.cpu_total = next_num(&mut it).unwrap_or(0);
                s.cpu_idle = next_num(&mut it).unwrap_or(0);
            }
            Some("mem") => {
                s.mem_total_kb = next_num(&mut it).unwrap_or(0);
                s.mem_avail_kb = next_num(&mut it).unwrap_or(0);
            }
            Some("disk") => {
                s.disk_total_kb = next_num(&mut it).unwrap_or(0);
                s.disk_used_kb = next_num(&mut it).unwrap_or(0);
            }
            Some("net") => {
                s.net_rx = next_num(&mut it).unwrap_or(0);
                s.net_tx = next_num(&mut it).unwrap_or(0);
            }
            Some("load") => s.load1 = next_num(&mut it).unwrap_or(0.0),
            Some("up") => s.uptime_secs = next_num(&mut it).unwrap_or(0.0),
            _ => {}
        }
    }
    s
}

/// Snapshot a live session's server vitals over a dedicated exec channel.
#[tauri::command]
pub async fn server_stats(
    state: State<'_, SshSessions>,
    id: u32,
) -> Result<ServerStats, String> {
    let handle = state
        .maps
        .handles
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("no such session")?;
    let cap =
        exec_capture_capped(&handle, STATS_CMD, std::time::Duration::from_secs(8), 8192).await?;
    Ok(parse_stats(&cap.stdout))
}

/// Slugs the frontend has icons for; anything else degrades to "linux".
const KNOWN_OS_IDS: &[&str] = &[
    "ubuntu", "debian", "fedora", "centos", "arch", "alpine", "kali", "gentoo", "nixos",
];

fn normalize_os_id(id: &str) -> Option<String> {
    let slug = match id {
        _ if KNOWN_OS_IDS.contains(&id) => id,
        "rhel" | "redhat" => "redhat",
        "rocky" | "rockylinux" => "rocky",
        "almalinux" | "alma" => "alma",
        "opensuse" | "suse" | "sles" => "opensuse",
        _ if id.starts_with("opensuse") => "opensuse",
        "amzn" | "amazon" => "amazon",
        "ol" | "oracle" => "oracle",
        "raspbian" => "raspbian",
        "linuxmint" | "mint" => "mint",
        "pop" => "ubuntu",
        _ => return None,
    };
    Some(slug.to_string())
}

/// Turn `uname -s` + `/etc/os-release` output into an OS slug.
pub(crate) fn parse_os_slug(out: &str) -> Option<String> {
    let lower = out.to_lowercase();
    let value_of = |key: &str| {
        lower.lines().find_map(|line| {
            line.trim()
                .strip_prefix(key)
                .map(|v| v.trim_matches('"').trim().to_string())
        })
    };
    if let Some(id) = value_of("id=") {
        if let Some(slug) = normalize_os_id(&id) {
            return Some(slug);
        }
    }
    // e.g. Pop!_OS: ID=pop ID_LIKE="ubuntu debian"
    if let Some(like) = value_of("id_like=") {
        if let Some(slug) = like.split_whitespace().find_map(normalize_os_id) {
            return Some(slug);
        }
    }
    for (needle, slug) in [
        ("darwin", "macos"),
        ("freebsd", "freebsd"),
        ("openbsd", "openbsd"),
        ("netbsd", "netbsd"),
        ("linux", "linux"),
    ] {
        if lower.contains(needle) {
            return Some(slug.to_string());
        }
    }
    None
}

/// Best-effort OS detection for the host-list icon. POSIX systems
/// answer the first probe; the `ver` fallback catches Windows hosts
/// whose default shell (cmd/powershell) chokes on the POSIX one.
#[tauri::command]
pub async fn ssh_detect_os(state: State<'_, SshSessions>, id: u32) -> Result<String, String> {
    let handle = state
        .maps
        .handles
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("no such session")?;
    if let Ok((_, out, _)) = exec_capture(
        &handle,
        "uname -s 2>/dev/null; cat /etc/os-release 2>/dev/null",
    )
    .await
    {
        if let Some(slug) = parse_os_slug(&out) {
            return Ok(slug);
        }
    }
    if let Ok((0, out, _)) = exec_capture(&handle, "cmd /c ver").await {
        if out.to_lowercase().contains("windows") {
            return Ok("windows".into());
        }
    }
    Ok(String::new())
}

/// Connect the whole chain and open an interactive shell on the final
/// hop. Returns every hop's handle (jumps first) — they must stay
/// alive as long as the session runs.
pub async fn open_shell(
    specs: &[ConnectSpec],
) -> Result<(Vec<Arc<SshHandle>>, russh::Channel<client::Msg>), ConnectError> {
    let chain = connect_chain(specs).await?;
    let target = chain.last().expect("chain not empty");
    let channel = target
        .channel_open_session()
        .await
        .map_err(ConnectError::other)?;
    if specs.last().is_some_and(|s| s.agent_forward) {
        let _ = channel.agent_forward(false).await;
    }
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(ConnectError::other)?;
    channel
        .request_shell(false)
        .await
        .map_err(ConnectError::other)?;
    Ok((chain, channel))
}

/// Open a shell and wire up the session pump; shared by ad-hoc and
/// saved-connection connects.
pub async fn start_session(
    app: AppHandle,
    sessions: &SshSessions,
    specs: &[ConnectSpec],
) -> Result<u32, ConnectError> {
    let (chain, mut channel) = open_shell(specs).await?;
    let target = Arc::clone(chain.last().expect("chain not empty"));

    let id = sessions.counter.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel::<TermCmd>();
    sessions.maps.senders.lock().unwrap().insert(id, tx);
    sessions
        .maps
        .handles
        .lock()
        .unwrap()
        .insert(id, Arc::clone(&target));
    sessions
        .maps
        .specs
        .lock()
        .unwrap()
        .insert(id, specs.to_vec());
    let maps = Arc::clone(&sessions.maps);

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
        // polite hangup, target first, then the jumps in reverse
        for handle in chain.iter().rev() {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "", "en")
                .await;
        }
        maps.senders.lock().unwrap().remove(&id);
        maps.handles.lock().unwrap().remove(&id);
        maps.sftp.lock().unwrap().remove(&id);
        let _ = app.emit(&format!("ssh-closed-{id}"), ());
    });

    Ok(id)
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshSessions>,
    lock: State<'_, crate::connections::StoreLock>,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<String>,
    jump_id: Option<String>,
    agent_forward: Option<bool>,
) -> Result<u32, ConnectError> {
    let target = ConnectSpec {
        host,
        port,
        user,
        password,
        key_path,
        agent_forward: agent_forward.unwrap_or(false),
    };
    let specs = crate::connections::resolve_chain(&lock, target, jump_id)?;
    start_session(app, &state, &specs).await
}

fn send_cmd(state: &State<'_, SshSessions>, id: u32, cmd: TermCmd) -> Result<(), String> {
    let senders = state.maps.senders.lock().unwrap();
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
    // explicit disconnect: nobody will reconnect this session
    state.maps.specs.lock().unwrap().remove(&id);
    Ok(())
}

/// Open an additional session with the same chain as an existing one
/// (split panes). The source session keeps its specs and stays up.
#[tauri::command]
pub async fn ssh_duplicate(
    app: AppHandle,
    state: State<'_, SshSessions>,
    id: u32,
) -> Result<u32, ConnectError> {
    let specs = state
        .maps
        .specs
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| ConnectError::other("no session to duplicate"))?;
    start_session(app, &state, &specs).await
}

/// Start a fresh session with the same chain a (possibly dead) session
/// was opened with. The old session's specs are consumed.
#[tauri::command]
pub async fn ssh_reconnect(
    app: AppHandle,
    state: State<'_, SshSessions>,
    id: u32,
) -> Result<u32, ConnectError> {
    let specs = state
        .maps
        .specs
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| ConnectError::other("nothing to reconnect"))?;
    let _ = send_cmd(&state, id, TermCmd::Close);
    start_session(app, &state, &specs).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ67aMfdava0ARCxRfHgX0i7CuJSVXC6Fttj8I2fg+xA";
    const KEY_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKAImG70JQNvehB5oxvEa76XsLgphdNRQNBNDTLp9ZLS";

    #[test]
    fn stats_parsing() {
        let out = "cores 8\ncpu 123456 100000\nmem 16384000 8192000\ndisk 209715200 104857600\nnet 5000 6000\nload 0.42\nup 98765.43\n";
        let s = parse_stats(out);
        assert_eq!(s.cores, 8);
        assert_eq!(s.cpu_total, 123456);
        assert_eq!(s.cpu_idle, 100000);
        assert_eq!(s.mem_total_kb, 16384000);
        assert_eq!(s.mem_avail_kb, 8192000);
        assert_eq!(s.disk_total_kb, 209715200);
        assert_eq!(s.disk_used_kb, 104857600);
        assert_eq!(s.net_rx, 5000);
        assert_eq!(s.net_tx, 6000);
        assert!((s.load1 - 0.42).abs() < f64::EPSILON);
        assert!((s.uptime_secs - 98765.43).abs() < 0.01);
    }

    #[test]
    fn stats_parsing_tolerates_missing_lines() {
        // a host without /proc (or a failed df) yields zeros, not an error
        let s = parse_stats("cores 4\ngarbage here\n");
        assert_eq!(s.cores, 4);
        assert_eq!(s.mem_total_kb, 0);
        assert_eq!(s.disk_total_kb, 0);
        assert_eq!(s.load1, 0.0);
    }

    #[test]
    fn os_slug_parsing() {
        let ubuntu = "Linux\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nNAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian";
        assert_eq!(parse_os_slug(ubuntu).as_deref(), Some("ubuntu"));
        // Pop!_OS falls back to ID_LIKE
        let pop = "Linux\nNAME=\"Pop!_OS\"\nID=pop\nID_LIKE=\"ubuntu debian\"";
        assert_eq!(parse_os_slug(pop).as_deref(), Some("ubuntu"));
        let rhel = "Linux\nNAME=\"Red Hat Enterprise Linux\"\nID=\"rhel\"\nID_LIKE=\"fedora\"";
        assert_eq!(parse_os_slug(rhel).as_deref(), Some("redhat"));
        let leap = "Linux\nID=\"opensuse-leap\"\nID_LIKE=\"suse opensuse\"";
        assert_eq!(parse_os_slug(leap).as_deref(), Some("opensuse"));
        assert_eq!(parse_os_slug("Darwin").as_deref(), Some("macos"));
        assert_eq!(parse_os_slug("FreeBSD").as_deref(), Some("freebsd"));
        // unknown distro without os-release still counts as linux
        assert_eq!(parse_os_slug("Linux").as_deref(), Some("linux"));
        assert_eq!(parse_os_slug("'uname' is not recognized"), None);
    }

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
