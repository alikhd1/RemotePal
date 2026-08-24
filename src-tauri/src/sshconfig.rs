//! Integration with the OS ssh setup: a RemotePal-managed block
//! inside ~/.ssh/config (so plain `ssh <name>` works anywhere) and
//! launching the system terminal.

use std::process::Command;

use crate::connections::{self, SavedConnection};

const MANAGED_BEGIN: &str = "# >>> RemotePal managed block >>>";
const MANAGED_END: &str = "# <<< RemotePal managed block <<<";

fn alias(name: &str) -> String {
    if name.chars().any(char::is_whitespace) {
        format!("\"{name}\"")
    } else {
        name.to_string()
    }
}

fn block_for(conns: &[SavedConnection]) -> Vec<String> {
    let mut lines = vec![MANAGED_BEGIN.to_string()];
    for conn in conns.iter().filter(|c| !c.name.is_empty()) {
        lines.push(format!("Host {}", alias(&conn.name)));
        lines.push(format!("    HostName {}", conn.host));
        lines.push(format!("    User {}", conn.user));
        if conn.port != 22 {
            lines.push(format!("    Port {}", conn.port));
        }
        if !conn.key_path.is_empty() {
            lines.push(format!("    IdentityFile \"{}\"", conn.key_path));
        }
        if !conn.jump.is_empty() {
            if let Some(jump) = conns.iter().find(|c| c.id == conn.jump) {
                if !jump.name.is_empty() {
                    lines.push(format!("    ProxyJump {}", alias(&jump.name)));
                }
            }
        }
    }
    lines.push(MANAGED_END.to_string());
    lines
}

/// Replace the RemotePal-managed block inside ~/.ssh/config. Called
/// after every connections mutation; failures are non-fatal for the
/// caller.
pub(crate) fn sync_ssh_config() -> Result<(), String> {
    let conns = connections::load_all()?;
    let ssh = dirs::home_dir()
        .ok_or("no home directory")?
        .join(".ssh");
    std::fs::create_dir_all(&ssh).map_err(|e| e.to_string())?;
    let config = ssh.join("config");
    let text = std::fs::read_to_string(&config).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let (head, tail): (Vec<String>, Vec<String>) = match (
        lines.iter().position(|l| l.trim() == MANAGED_BEGIN),
        lines.iter().position(|l| l.trim() == MANAGED_END),
    ) {
        (Some(b), Some(e)) if b <= e => (
            lines[..b].iter().map(|s| s.to_string()).collect(),
            lines[e + 1..].iter().map(|s| s.to_string()).collect(),
        ),
        _ => (lines.iter().map(|s| s.to_string()).collect(), Vec::new()),
    };
    let mut out = head;
    out.extend(block_for(&conns));
    out.extend(tail);
    std::fs::write(&config, out.join("\n") + "\n").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_config_sync() -> Result<(), String> {
    sync_ssh_config()
}

/// Launch the OS terminal with `ssh` for a saved connection. The
/// managed config block makes `ssh <name>` resolve keys and jumps.
#[tauri::command]
pub fn external_terminal(id: String) -> Result<(), String> {
    let conn = connections::load_all()?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or("saved connection not found")?;
    let _ = sync_ssh_config();
    let target = if conn.name.is_empty() {
        format!("{}@{}", conn.user, conn.host)
    } else {
        conn.name.clone()
    };
    let mut args: Vec<String> = vec![
        "/C".into(),
        "start".into(),
        "".into(),
        "ssh".into(),
        target,
    ];
    if conn.name.is_empty() && conn.port != 22 {
        args.push("-p".into());
        args.push(conn.port.to_string());
    }
    Command::new("cmd")
        .args(&args)
        .spawn()
        .map_err(|e| format!("cannot launch terminal: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_block_renders_and_quotes() {
        let conns = vec![
            SavedConnection {
                id: "a".into(),
                name: "web prod".into(),
                host: "web.example".into(),
                port: 2222,
                user: "root".into(),
                key_path: "C:\\keys\\id".into(),
                has_password: false,
                jump: "b".into(),
                forwards: Vec::new(),
                group: String::new(),
                agent_forward: false,
                os: String::new(),
                tags: Vec::new(),
            },
            SavedConnection {
                id: "b".into(),
                name: "gateway".into(),
                host: "gw.example".into(),
                port: 22,
                user: "jump".into(),
                key_path: String::new(),
                has_password: false,
                jump: String::new(),
                forwards: Vec::new(),
                group: String::new(),
                agent_forward: false,
                os: String::new(),
                tags: Vec::new(),
            },
        ];
        let block = block_for(&conns).join("\n");
        assert!(block.contains("Host \"web prod\""));
        assert!(block.contains("Port 2222"));
        assert!(block.contains("IdentityFile \"C:\\keys\\id\""));
        assert!(block.contains("ProxyJump gateway"));
        assert!(block.contains("Host gateway"));
        assert!(!block.contains("Port 22\n"), "default port omitted");
    }
}
