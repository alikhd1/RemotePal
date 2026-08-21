# RemotePal

An open source alternative to Termius — a portable, cross-platform
(Windows / macOS / Linux) SSH key & server manager with a built-in terminal,
SFTP and S3 file browsers, and encrypted sync between your machines. Built
with [Tauri 2](https://tauri.app), React, and [xterm.js](https://xtermjs.org)
on a Rust ([russh](https://crates.io/crates/russh)) SSH backend. Local-first:
your data never touches anyone's cloud but your own.

[![CI](https://github.com/alikhd1/RemotePal/actions/workflows/ci.yml/badge.svg)](https://github.com/alikhd1/RemotePal/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- TODO: add a screenshot, e.g. ![RemotePal](docs/screenshot.png) -->

## Features

- **Tabbed terminals** — xterm.js (WebGL renderer) wired to a russh PTY
  channel; multiple concurrent sessions, live PTY resize, disconnect
  indicators, and hidden sessions stay connected
- **Split panes** — split a terminal right or down (`Ctrl+Shift+D` /
  `Ctrl+Shift+E`, or the tab-bar buttons); each pane opens its own SSH
  session over the same connection chain, dividers drag to resize, and
  `Ctrl+Shift+W` closes the focused pane
- **Saved connections** — metadata in `~/.remotepal/connections.json`,
  passwords in the OS credential store (never on disk); one-click connect,
  edit/delete
- **Host key verification** — trust-on-first-use against
  `~/.remotepal/known_hosts` with SHA256 fingerprints, and a loud warning
  when a host's key changes
- **SFTP browser** — per-session Files panel that reuses the SSH connection
  (no re-auth): navigation, upload/download with progress, new dir, rename,
  delete, multi-select, and OS drag-and-drop upload
- **Edit-on-save** — open a remote file in your local editor; saves re-upload
  automatically (debounced file watcher)
- **S3 browser** — storages (secret keys in the credential store) open as
  tabs with prefix navigation, upload/download with progress, rename, and
  recursive prefix delete; works with AWS or any custom endpoint (MinIO,
  moto) via path-style addressing
- **Port forwards** — local forwards (`-L`) per session with a Forwards
  strip in the tab bar
- **Jump hosts** — saved connections can chain through other saved
  connections (nested, cycle-safe), with per-hop host key verification
- **Folder sync** — push missing/changed files to the remote, with optional
  mirror deletes
- **Snippets** — per-session snippets panel; `{host}` `{user}` `{port}`
  `{name}` fill in automatically, other `{placeholders}` prompt on send,
  multi-line commands run line by line
- **Themes** — One Dark, Light, Solarized Dark, Nord; applied live to the
  app and all open terminals, persisted across restarts
- **Encrypted vault backups** — PBKDF2-SHA256 (600k iterations) + Fernet
  over tar.gz; export/import connections, S3 storages, snippets, bundled
  keys, and stored secrets to move your whole setup between machines

## Install

Installers are published on the
[Releases](https://github.com/alikhd1/RemotePal/releases) page, built by CI
from version tags. Until a release is out, build from source (below).

Windows builds are the most tested today; macOS and Linux build from the
same codebase.

## Building from source

Prereqs: Node 20+, Rust (MSVC toolchain on Windows), and the WebView2
runtime on Windows.

```sh
npm install
npm run tauri dev    # run in development
npm run tauri build  # produce the installer
```

## Architecture

- `src/` — React frontend. `TerminalPane.tsx` owns one xterm.js instance;
  keystrokes go to `ssh_write`, output arrives as base64 on the
  `ssh-data-{id}` event, resizes call `ssh_resize`.
- `src-tauri/src/ssh.rs` — one async pump task per session owns the russh
  channel; Tauri commands talk to it through an mpsc sender. Session ends
  emit `ssh-closed-{id}`.

## Contributing

Issues and pull requests are welcome. For anything substantial, please open
an issue first so we can discuss the approach. `npm run build` type-checks
the frontend, and `cargo check` inside `src-tauri` covers the Rust side —
CI runs both on every PR.

## License

[MIT](LICENSE)
