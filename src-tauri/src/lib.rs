pub mod connections;
pub mod sftp;
pub mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ssh::SshSessions::default())
        .manage(connections::StoreLock::default())
        .manage(sftp::EditState::default())
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
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_edit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
