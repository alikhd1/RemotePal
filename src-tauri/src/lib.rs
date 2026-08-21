pub mod connections;
pub mod forwards;
pub mod keys;
pub mod s3;
pub mod sftp;
pub mod ssh;
pub mod sshconfig;
pub mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ssh::SshSessions::default())
        .manage(connections::StoreLock::default())
        .manage(sftp::EditState::default())
        .manage(s3::S3StoreLock::default())
        .manage(s3::S3EditState::default())
        .manage(forwards::Forwards::default())
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::ssh_reconnect,
            ssh::ssh_duplicate,
            ssh::trust_host_key,
            connections::connections_list,
            connections::connection_save,
            connections::connection_delete,
            connections::ssh_connect_saved,
            connections::deploy_key,
            sshconfig::ssh_config_sync,
            sshconfig::external_terminal,
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_edit,
            sftp::sftp_sync,
            s3::s3_list_storages,
            s3::s3_save_storage,
            s3::s3_delete_storage,
            s3::s3_list,
            s3::s3_upload,
            s3::s3_download,
            s3::s3_delete,
            s3::s3_rename,
            s3::s3_list_buckets,
            s3::s3_create_bucket,
            s3::s3_presign,
            s3::s3_sync,
            s3::s3_edit,
            forwards::forward_start,
            forwards::forward_stop,
            forwards::forwards_list,
            forwards::forward_pin,
            keys::keys_list,
            keys::key_generate,
            keys::key_import_file,
            keys::keys_import_os,
            keys::key_install_os,
            keys::key_delete,
            vault::snippets_list,
            vault::snippets_save,
            vault::vault_export,
            vault::vault_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
