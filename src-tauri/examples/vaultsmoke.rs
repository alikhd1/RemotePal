//! Compatibility smoke test: import a backup exported by the PyQt
//! app's vault.py into a fresh Tauri vault.
//! `cargo run --example vaultsmoke -- <backup.rpal> <password>`

fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: vaultsmoke <backup> <password>";
    let backup = args.next().expect(usage);
    let password = args.next().expect(usage);

    let dir = std::env::temp_dir().join(format!(
        "remotepal-vaultsmoke-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::env::set_var("REMOTEPAL_VAULT_DIR", &dir);

    assert!(
        remotepal_lib::vault::import_backup(&backup, "definitely-wrong").is_err(),
        "wrong password must fail"
    );

    let summary =
        remotepal_lib::vault::import_backup(&backup, &password).expect("import failed");
    println!(
        "imported: {} connections, {} storages, {} snippets, {} keys",
        summary.connections, summary.storages, summary.snippets, summary.keys
    );

    let conns = remotepal_lib::connections::load_all().expect("load connections");
    let server = conns
        .iter()
        .find(|c| c.name == "pyserver")
        .expect("pyserver imported");
    let jump = conns
        .iter()
        .find(|c| c.name == "pyjump")
        .expect("pyjump imported");
    assert_eq!(jump.jump, server.id, "jump wired from name to id");
    assert!(server.has_password, "password flag imported");
    let entry =
        keyring::Entry::new("RemotePal", &server.id).expect("credential store entry");
    assert_eq!(
        entry.get_password().expect("stored password"),
        "sekret",
        "password moved into the credential store"
    );
    // clean the credential store again
    for conn in conns.iter().filter(|c| c.has_password) {
        if let Ok(entry) = keyring::Entry::new("RemotePal", &conn.id) {
            let _ = entry.delete_credential();
        }
    }

    let snippets = remotepal_lib::vault::snippets_list().expect("snippets");
    assert!(
        snippets
            .iter()
            .any(|s| s.name == "uptime" && s.command == "uptime"),
        "snippet imported"
    );

    let _ = std::fs::remove_dir_all(&dir);
    println!("VAULT SMOKE OK");
}
