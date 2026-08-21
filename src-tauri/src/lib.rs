pub mod connections;
pub mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ssh::SshSessions::default())
        .manage(connections::StoreLock::default())
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::trust_host_key,
            connections::connections_list,
            connections::connection_save,
            connections::connection_delete,
            connections::ssh_connect_saved,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
