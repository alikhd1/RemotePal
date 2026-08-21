//! Headless smoke test for the SSH layer, run against the demo sshd from
//! the RemotePal-python repo: `cargo run --example smoke -- <port> <password>`.
//!
//! Covers: trust-on-first-use (fresh vault must reject, trusting must
//! fix), PTY echo, SFTP round-trip, a real local port forward, and a
//! two-hop jump chain (through the demo server to itself).

use std::sync::Arc;
use std::time::Duration;

use remotepal_lib::forwards::start_forward;
use remotepal_lib::ssh::{open_shell, trust_host_key_inner, ConnectError, ConnectSpec};
use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn spec(port: u16, password: &str) -> ConnectSpec {
    ConnectSpec {
        host: "127.0.0.1".into(),
        port,
        user: "demo".into(),
        password: Some(password.into()),
        key_path: None,
        agent_forward: false,
    }
}

async fn expect_echo(
    channel: &mut russh::Channel<russh::client::Msg>,
    line: &str,
) {
    channel
        .data(format!("{line}\r").as_bytes())
        .await
        .expect("write failed");
    let want = format!("you typed: {line}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut seen = String::new();
    loop {
        let msg = tokio::time::timeout_at(deadline, channel.wait())
            .await
            .unwrap_or_else(|_| panic!("timed out; saw only: {seen:?}"));
        match msg {
            Some(ChannelMsg::Data { ref data }) => {
                seen.push_str(&String::from_utf8_lossy(&data[..]));
                if seen.contains(&want) {
                    return;
                }
            }
            None => panic!("channel closed early; saw: {seen:?}"),
            _ => {}
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    // start_forward spawns via tauri's async runtime; back it with ours
    tauri::async_runtime::set(tokio::runtime::Handle::current());
    let mut args = std::env::args().skip(1);
    let usage = "usage: smoke <port> <password>";
    let port: u16 = args.next().expect(usage).parse().expect(usage);
    let password = args.next().expect(usage);

    // fresh vault so the host is always unknown at first
    let vault = std::env::temp_dir().join(format!("remotepal-smoke-vault-{port}"));
    let _ = std::fs::remove_dir_all(&vault);
    std::env::set_var("REMOTEPAL_VAULT_DIR", &vault);

    let first = open_shell(&[spec(port, &password)]).await;
    let (host, key_openssh) = match first {
        Err(ConnectError::HostKeyUnknown {
            host,
            fingerprint,
            key_openssh,
            ..
        }) => {
            println!("TOFU prompt as expected: {fingerprint}");
            (host, key_openssh)
        }
        Ok(_) => panic!("fresh vault must not silently trust the host"),
        Err(e) => panic!("expected HostKeyUnknown, got: {e:?}"),
    };
    trust_host_key_inner(&host, port, &key_openssh).expect("trust failed");

    let (chain, mut channel) = open_shell(&[spec(port, &password)])
        .await
        .expect("connect after trust failed");
    let session = chain.last().expect("chain not empty");

    expect_echo(&mut channel, "hello").await;
    println!("ECHO OK");

    // SFTP round-trip on a second channel of the same connection —
    // the same path the file browser uses.
    let sftp_channel = session.channel_open_session().await.expect("sftp channel");
    sftp_channel
        .request_subsystem(true, "sftp")
        .await
        .expect("sftp subsystem");
    let sftp = russh_sftp::client::SftpSession::new(sftp_channel.into_stream())
        .await
        .expect("sftp session");
    let home = sftp.canonicalize(".").await.expect("canonicalize");
    let test_path = if home.ends_with('/') {
        format!("{home}smoke-test.txt")
    } else {
        format!("{home}/smoke-test.txt")
    };
    let mut f = sftp.create(&test_path).await.expect("sftp create");
    f.write_all(b"remotepal smoke").await.expect("sftp write");
    f.flush().await.expect("sftp flush");
    f.shutdown().await.expect("sftp close");
    let mut f = sftp.open(&test_path).await.expect("sftp open");
    let mut text = String::new();
    f.read_to_string(&mut text).await.expect("sftp read");
    f.shutdown().await.expect("sftp close read handle");
    assert_eq!(text, "remotepal smoke", "sftp roundtrip content mismatch");
    let names: Vec<String> = sftp
        .read_dir(&home)
        .await
        .expect("sftp read_dir")
        .map(|e| e.file_name())
        .collect();
    assert!(
        names.contains(&"smoke-test.txt".to_string()),
        "listing misses the test file: {names:?}"
    );
    sftp.remove_file(&test_path).await.expect("sftp remove");
    println!("SFTP OK: home={home}");

    // Local port forward: tunnel back to the demo sshd itself and read
    // its SSH banner through the tunnel.
    let (fwd_port, _stop) = start_forward(
        Arc::clone(session),
        0,
        "127.0.0.1".to_string(),
        port,
    )
    .await
    .expect("start forward");
    let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", fwd_port))
        .await
        .expect("connect through forward");
    let mut banner = [0u8; 7];
    tokio::time::timeout(Duration::from_secs(5), tcp.read_exact(&mut banner))
        .await
        .expect("banner timeout")
        .expect("banner read");
    assert_eq!(&banner, b"SSH-2.0", "unexpected banner: {banner:?}");
    println!("FORWARD OK: 127.0.0.1:{fwd_port}");

    // Exec channel (the deploy-key transport): the demo server replies
    // "ok" and exit status 0 to any exec request.
    let (status, stderr) = remotepal_lib::ssh::exec_on(session, "echo remotepal")
        .await
        .expect("exec failed");
    assert_eq!(status, 0, "exec exit status; stderr: {stderr}");
    println!("EXEC OK");

    // Jump chain: reach the demo server by hopping through itself —
    // hop 2 runs over a direct-tcpip channel of hop 1.
    let (jump_chain, mut jump_channel) =
        open_shell(&[spec(port, &password), spec(port, &password)])
            .await
            .expect("jump connect failed");
    assert_eq!(jump_chain.len(), 2, "expected two hops");
    expect_echo(&mut jump_channel, "via-jump").await;
    for handle in jump_chain.iter().rev() {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    println!("JUMP OK");

    for handle in chain.iter().rev() {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    let _ = std::fs::remove_dir_all(&vault);
    println!("SMOKE OK");
}
