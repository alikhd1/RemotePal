import ReactDOM from "react-dom/client";
import App from "./App";

async function boot() {
  // outside Tauri (browser dev) install the canned-data IPC shim first
  if (!("__TAURI_INTERNALS__" in window)) {
    await import("./devMock");
  }
  // No StrictMode: its dev-mode double-mount would open and immediately
  // tear down a real SSH session in TerminalPane's effect.
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />,
  );
}

boot();
