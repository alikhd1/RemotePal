import ReactDOM from "react-dom/client";
import App from "./App";

// No StrictMode: its dev-mode double-mount would open and immediately
// tear down a real SSH session in TerminalPane's effect.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
