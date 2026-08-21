//! Headless smoke test for the SSH layer, run against the demo sshd from
//! the PyQt repo: `cargo run --example smoke -- <port> <password>`.
//! Connects to 127.0.0.1, opens a PTY shell, types "hello", and expects
//! the echo shell to answer "you typed: hello".

use std::time::Duration;

use russh::ChannelMsg;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: smoke <port> <password>";
    let port: u16 = args.next().expect(usage).parse().expect(usage);
    let password = args.next().expect(usage);

    let (session, mut channel) = remotepal_lib::ssh::open_shell(
        "127.0.0.1",
        port,
        "demo",
        Some(password),
        None,
    )
    .await
    .expect("connect+auth+shell failed");

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
    println!("SMOKE OK");
}
