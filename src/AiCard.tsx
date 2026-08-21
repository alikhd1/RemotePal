import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Select } from "./Dropdown";
import {
  getProviders,
  getProvider,
  setProvider,
  getModel,
  setModel,
  defaultModelFor,
  providerDef,
  addCustomProvider,
  removeCustomProvider,
} from "./aiConfig";

// Provider + API-key settings. Users can select a built-in provider
// (Anthropic, GapGPT) or define their own OpenAI-compatible endpoint.
// Each provider's key is stored in the OS keyring (service "RemotePal-AI",
// account = provider id) by the backend; the webview never sees a key
// back. The active provider and models are kept in localStorage (aiConfig)
// so the docked AiPanel picks them up.
function AiCard() {
  const [provider, setProviderState] = useState(getProvider());
  const [key, setKey] = useState("");
  const [present, setPresent] = useState(false);
  const [model, setModelState] = useState(getModel(getProvider()));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Touch ID (macOS): gate the stored key behind a fingerprint
  const [bioAvailable, setBioAvailable] = useState(false);
  const [useBiometric, setUseBiometric] = useState(false);

  // add-provider form
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addModel, setAddModel] = useState("");

  const def = providerDef(provider);
  const providers = getProviders();

  function refreshStatus(p: string) {
    invoke<boolean>("ai_key_status", { provider: p })
      .then(setPresent)
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refreshStatus(provider);
  }, [provider]);

  useEffect(() => {
    invoke<boolean>("ai_biometric_available")
      .then(setBioAvailable)
      .catch(() => setBioAvailable(false));
  }, []);

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
      await invoke("ai_key_save", {
        key,
        provider,
        biometric: bioAvailable && useBiometric,
      });
      setKey("");
      setPresent(true);
      setNotice(
        bioAvailable && useBiometric
          ? `${def.label} key saved behind Touch ID.`
          : `${def.label} key saved.`,
      );
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

  async function deleteProvider() {
    // clear its stored key, then drop the definition
    try {
      await invoke("ai_key_save", { key: "", provider });
    } catch {
      /* ignore — removing anyway */
    }
    removeCustomProvider(provider);
    switchProvider(getProvider());
    setNotice("Provider removed.");
  }

  function addProvider() {
    if (!addName.trim() || !addUrl.trim()) {
      setError("Name and endpoint URL are required.");
      return;
    }
    const id = addCustomProvider({
      label: addName,
      baseUrl: addUrl,
      defaultModel: addModel,
    });
    setAddOpen(false);
    setAddName("");
    setAddUrl("");
    setAddModel("");
    switchProvider(id);
    setNotice("Provider added — now set its API key.");
  }

  return (
    <div className="saved-panel">
      <h2>AI Copilot</h2>

      <label className="ai-field-label">Provider</label>
      <Select
        value={provider}
        options={providers.map((p) => ({ value: p.id, label: p.label }))}
        onChange={switchProvider}
      />

      {def.kind === "openai" && def.baseUrl && (
        <div className="ai-endpoint">{def.baseUrl}</div>
      )}

      <label className="ai-field-label">
        API key
        {def.requiresKey === false && (
          <span className="si-dim"> — not required for this provider</span>
        )}
      </label>
      <input
        type="password"
        className="vault-pass"
        value={key}
        onChange={(e) => setKey(e.currentTarget.value)}
        placeholder={
          present ? "key set — enter a new one to replace" : `${def.label} API key`
        }
      />
      {bioAvailable && (
        <label className="ai-bio-toggle" title="Require Touch ID to read this key">
          <input
            type="checkbox"
            checked={useBiometric}
            onChange={(e) => setUseBiometric(e.currentTarget.checked)}
          />
          Protect with Touch ID
        </label>
      )}
      <div className="vault-buttons">
        <button type="button" disabled={busy} onClick={save}>
          Save
        </button>
        {present && (
          <button type="button" disabled={busy} onClick={clear}>
            Remove key
          </button>
        )}
        {!def.builtin && (
          <button type="button" disabled={busy} onClick={deleteProvider}>
            Delete provider
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

      {addOpen ? (
        <div className="ai-add-provider">
          <label className="ai-field-label">New provider name</label>
          <input
            className="vault-pass"
            value={addName}
            onChange={(e) => setAddName(e.currentTarget.value)}
            placeholder="e.g. My proxy"
          />
          <label className="ai-field-label">
            Endpoint URL (OpenAI-compatible /chat/completions)
          </label>
          <input
            className="vault-pass"
            value={addUrl}
            onChange={(e) => setAddUrl(e.currentTarget.value)}
            placeholder="https://…/v1/chat/completions"
          />
          <label className="ai-field-label">Default model</label>
          <input
            className="vault-pass"
            value={addModel}
            onChange={(e) => setAddModel(e.currentTarget.value)}
            placeholder="gpt-4o"
          />
          <div className="vault-buttons">
            <button type="button" onClick={addProvider}>
              Add
            </button>
            <button type="button" onClick={() => setAddOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="link-btn ai-add-toggle"
          onClick={() => {
            setAddOpen(true);
            setError(null);
            setNotice(null);
          }}
        >
          + Add a provider
        </button>
      )}

      <div className="saved-empty">
        Add any OpenAI-compatible endpoint as a provider and pick it in the
        Copilot panel. Keys are stored in the OS credential store, never in the
        app files.
      </div>
      {notice && <div className="connect-notice">{notice}</div>}
      {error && <div className="connect-error">{error}</div>}
    </div>
  );
}

export default AiCard;
