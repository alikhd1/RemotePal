//! Headless smoke test for the SSH layer, run against the demo sshd from
//! the PyQt repo: `cargo run --example smoke -- <port> <password>`.
//!
//! Exercises the trust-on-first-use flow end to end: with a fresh vault
//! the first connect must fail with HostKeyUnknown; after trusting the
//! key the retry must succeed, open a PTY shell, type "hello", and get
//! the echo shell's "you typed: hello" back.

use std::time::Duration;

use remotepal_lib::ssh::{open_shell, trust_host_key_inner, ConnectError};
use russh::ChannelMsg;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: smoke <port> <password>";
    let port: u16 = args.next().expect(usage).parse().expect(usage);
    let password = args.next().expect(usage);

    // fresh vault so the host is always unknown at first
    let vault = std::env::temp_dir().join(format!("remotepal-smoke-vault-{port}"));
    let _ = std::fs::remove_dir_all(&vault);
    std::env::set_var("REMOTEPAL_VAULT_DIR", &vault);

    let first = open_shell("127.0.0.1", port, "demo", Some(password.clone()), None).await;
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

    let (session, mut channel) =
        open_shell("127.0.0.1", port, "demo", Some(password), None)
            .await
            .expect("connect after trust failed");

    channel.data(&b"hello\r"[..]).await.expect("write failed");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut seen = String::new();
    loop {
        let msg = tokio::time::timeout_at(deadline, channel.wait())
            .await
            .unwrap_or_else(|_| panic!("timed out; saw only: {seen:?}"));
        match msg {
            Some(ChannelMsg::Data { ref data }) => {
                seen.push_str(&String::from_utf8_lossy(&data[..]));
                if seen.contains("you typed: hello") {
                    break;
                }
            }
            None => panic!("channel closed early; saw: {seen:?}"),
            _ => {}
        }
    }

    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
    let _ = std::fs::remove_dir_all(&vault);
    println!("SMOKE OK");
}
