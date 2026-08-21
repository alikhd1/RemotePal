# RemotePal

A tabbed SSH client for Windows with built-in SFTP and S3 browsers, port
forwarding, jump hosts, snippets, and encrypted vault backups. Built with
[Tauri 2](https://tauri.app), React, and [xterm.js](https://xtermjs.org);
the SSH layer is Rust ([russh](https://crates.io/crates/russh)) streaming
PTY bytes to the frontend over Tauri events.

[![CI](https://github.com/alikhd1/RemotePal/actions/workflows/ci.yml/badge.svg)](https://github.com/alikhd1/RemotePal/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

RemotePal is the Tauri rewrite of
[RemotePal-python](https://github.com/alikhd1/RemotePal-python) (PyQt6), with
full feature parity. Both apps share the same `~/.remotepal` config format —
saved connections, known hosts, snippets, and encrypted vault backups made in
one app work in the other.

<!-- TODO: add a screenshot, e.g. ![RemotePal](docs/screenshot.png) -->

## Features

- **Tabbed terminals** — xterm.js (WebGL renderer) wired to a russh PTY
  channel; multiple concurrent sessions, live PTY resize, disconnect
  indicators, and hidden sessions stay connected
- **Saved connections** — metadata in `~/.remotepal/connections.json`,
  passwords in the Windows Credential Manager (never on disk); one-click
  connect, edit/delete
- **Host key verification** — trust-on-first-use against
  `~/.remotepal/known_hosts` with SHA256 fingerprints, and a loud warning
  when a host's key changes
- **SFTP browser** — per-session Files panel that reuses the SSH connection
  (no re-auth): navigation, upload/download with progress, new dir, rename,
  delete, multi-select, and OS drag-and-drop upload
- **Edit-on-save** — open a remote file in your local editor; saves re-upload
  automatically (debounced file watcher)
- **S3 browser** — storages (secret keys in the Credential Manager) open as
  tabs with prefix navigation, upload/download with progress, rename, and
  recursive prefix delete; works with AWS or any custom endpoint (MinIO,
  moto) via path-style addressing
- **Port forwards** — local forwards (`-L`) per session with a Forwards
  strip in the tab bar
- **Jump hosts** — saved connections can chain through other saved
  connections (nested, cycle-safe), with per-hop host key verification
- **Folder sync** — push missing/changed files to the remote, with optional
  mirror deletes
- **Snippets** — `snippets.json` shared with the PyQt app; `{host}` `{user}`
  `{port}` `{name}` fill in automatically, other `{placeholders}` prompt on
  send, multi-line commands run line by line
- **Themes** — One Dark, Light, Solarized Dark, Nord; applied live to the
  app and all open terminals, persisted across restarts
- **Encrypted vault backups** — byte-compatible with the PyQt app (RPAL1:
  PBKDF2-SHA256/600k + Fernet over tar.gz); export/import connections, S3
  storages, snippets, bundled keys, and stored secrets

## Install

Installers are published on the
[Releases](https://github.com/alikhd1/RemotePal/releases) page, built by CI
from version tags. Until a release is out, build from source (below).

Windows is the primary platform right now (WebView2, Credential Manager);
the stack is portable, but other platforms are untested.

## Building from source

Prereqs: Node 20+, Rust (MSVC toolchain on Windows), and the WebView2
runtime.

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
