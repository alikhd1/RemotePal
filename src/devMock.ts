// Browser-only dev shim. When the frontend runs outside Tauri (plain
// `npm run dev` opened in a browser), there is no IPC bridge and every
// invoke() rejects. This installs a fake bridge with canned read-only
// data so the home screen is browsable for UI work. The real desktop
// app never loads this module (main.tsx gates on __TAURI_INTERNALS__).

const sampleConnections = [
  { name: "web-prod-1", host: "10.0.1.10", user: "root", group: "Production", os: "ubuntu" },
  { name: "web-prod-2", host: "10.0.1.11", user: "root", group: "Production", os: "ubuntu" },
  { name: "db-primary", host: "10.0.1.20", user: "postgres", group: "Production", os: "debian" },
  { name: "bastion", host: "203.0.113.7", user: "jump", group: "Production", os: "alpine" },
  { name: "staging", host: "10.1.0.5", user: "deploy", group: "Staging", os: "rocky" },
  { name: "ci-runner", host: "10.1.0.9", user: "runner", group: "Staging", os: "arch" },
  { name: "win-build", host: "10.2.0.4", user: "admin", group: "", os: "windows" },
  { name: "mac-mini", host: "10.2.0.6", user: "ci", group: "", os: "macos" },
  { name: "pentest-box", host: "192.168.56.101", user: "kali", group: "", os: "kali" },
  { name: "new-vps", host: "198.51.100.23", user: "root", group: "", os: "" },
].map((c, i) => ({
  id: `mock-${i}`,
  port: 22,
  keyPath: "",
  hasPassword: i % 2 === 0,
  jump: "",
  agentForward: false,
  forwards: [],
  ...c,
}));

const handlers: Record<string, (args?: unknown) => unknown> = {
  connections_list: () => sampleConnections,
  keys_list: () => [
    {
      name: "id_ed25519",
      path: "C:\\Users\\me\\.remotepal\\keys\\id_ed25519",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI… me@pc",
    },
  ],
  s3_list_storages: () => [
    {
      id: "mock-s3",
      name: "backups",
      endpoint: "",
      region: "us-east-1",
      bucket: "acme-backups",
      accessKey: "AKIA…",
      pathStyle: false,
    },
  ],
  "plugin:event|listen": () => 0,
  "plugin:event|unlisten": () => undefined,
};

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (cmd: string) => {
    const handler = handlers[cmd];
    if (handler) return Promise.resolve(handler());
    return Promise.reject({
      message: `browser preview: "${cmd}" needs the desktop app`,
    });
  },
  transformCallback: (() => {
    let n = 0;
    return () => ++n;
  })(),
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main" },
  },
};

export {};
