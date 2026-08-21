# RemotePal (Tauri)

Tauri + React rewrite of [RemotePal](https://github.com/alikhd1/RemotePal-python), the PyQt6 SSH manager. The terminal is xterm.js in a WebView2 window; the SSH layer is Rust ([russh](https://crates.io/crates/russh)) streaming PTY bytes to the frontend over Tauri events.

## Status

Early. Working so far:

- Connect form (host / port / user, password or private-key auth)
- Interactive terminal: xterm.js (WebGL renderer) wired to a russh PTY channel
- Live PTY resize, disconnect banner
- Session tabs: multiple concurrent connections, "+" tab for new sessions,
  disconnect indicator; hidden sessions stay connected
- Saved connections: metadata in `~/.remotepal/connections.json`, passwords
  in the Windows Credential Manager (never on disk); one-click connect,
  edit/delete
- Host key verification against `~/.remotepal/known_hosts` (shared with the
  PyQt app): trust-on-first-use dialog with the SHA256 fingerprint, and a
  loud warning when a host's key changes; trusting a changed key replaces
  the stale entry
- SFTP browser: per-session "Files" panel beside the terminal (reuses the
  SSH connection, no re-auth) with navigation, upload/download with
  progress, new dir, rename, and delete

Not yet ported from the PyQt app: vault encryption/backup, edit-on-save auto-upload, S3 browser, folder sync, port forwards, jump hosts, themes.

## Development

Prereqs: Node 20+, Rust (MSVC toolchain on Windows), WebView2 runtime.

```
npm install
npm run tauri dev
```

`npm run tauri build` produces the installer.

## Architecture

- `src/` — React frontend. `TerminalPane.tsx` owns one xterm.js instance; keystrokes go to `ssh_write`, output arrives as base64 on the `ssh-data-{id}` event, resizes call `ssh_resize`.
- `src-tauri/src/ssh.rs` — one async pump task per session owns the russh channel; Tauri commands talk to it through an mpsc sender. Session ends emit `ssh-closed-{id}`.
