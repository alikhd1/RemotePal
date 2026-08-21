import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Select } from "./Dropdown";
import {
  PROVIDERS,
  getProvider,
  setProvider,
  getModel,
  setModel,
  defaultModelFor,
  providerDef,
} from "./aiConfig";

// API-key + provider settings for the AI copilot. Each provider's key is
// stored in the OS keyring (service "RemotePal-AI", account = provider) by
// the backend; the webview never receives a key back — this card only
// learns whether one is present. The active provider and model are kept in
// localStorage (see aiConfig) so the docked AiPanel picks them up.
function AiCard() {
  const [provider, setProviderState] = useState(getProvider());
  const [key, setKey] = useState("");
  const [present, setPresent] = useState(false);
  const [model, setModelState] = useState(getModel(getProvider()));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const def = providerDef(provider);

  function refreshStatus(p: string) {
    invoke<boolean>("ai_key_status", { provider: p })
      .then(setPresent)
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refreshStatus(provider);
  }, [provider]);

  function switchProvider(p: string) {
    setProvider(p);
    setProviderState(p);
    setModelState(getModel(p));
    setKey("");
    setNotice(null);
    setError(null);
  }

  async function save() {
    if (!key) {
      setError("Enter an API key first.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await invoke("ai_key_save", { key, provider });
      setKey("");
      setPresent(true);
      setNotice(`${def.label} key saved.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await invoke("ai_key_save", { key: "", provider });
      setKey("");
      setPresent(false);
      setNotice(`${def.label} key removed.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="saved-panel">
      <h2>AI Copilot</h2>

      <label className="ai-field-label">Provider</label>
      <Select
        value={provider}
        options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
        onChange={switchProvider}
      />

      <label className="ai-field-label">API key</label>
      <input
        type="password"
        className="vault-pass"
        value={key}
        onChange={(e) => setKey(e.currentTarget.value)}
        placeholder={present ? "key set — enter a new one to replace" : def.keyHint}
      />
      <div className="vault-buttons">
        <button type="button" disabled={busy} onClick={save}>
          Save
        </button>
        {present && (
          <button type="button" disabled={busy} onClick={clear}>
            Remove
          </button>
        )}
      </div>

      <label className="ai-field-label">Model</label>
      <input
        type="text"
        className="vault-pass"
        value={model}
        onChange={(e) => setModelState(e.currentTarget.value)}
        onBlur={() => setModel(provider, model)}
        placeholder={defaultModelFor(provider)}
      />

      <div className="saved-empty">
        {provider === "gapgpt"
          ? "GapGPT is an OpenAI-compatible endpoint (api.gapgpt.app). Keys are stored in the OS credential store, never in the app files."
          : "Your API key powers the Copilot panel. Stored in the OS credential store, never in the app files."}
      </div>
      {notice && <div className="connect-notice">{notice}</div>}
      {error && <div className="connect-error">{error}</div>}
    </div>
  );
}

export default AiCard;
