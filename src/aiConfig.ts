// Which AI provider/model the Copilot uses. Persisted in localStorage so
// the setting on the connect screen (AiCard) reaches the AiPanel docked in
// a terminal. Keys themselves live in the OS keyring (backend), one per
// provider — never here.

export interface ProviderDef {
  id: string;
  label: string;
  defaultModel: string;
  keyHint: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-opus-5",
    keyHint: "Anthropic API key (sk-ant-…)",
  },
  {
    id: "gapgpt",
    label: "GapGPT",
    defaultModel: "gpt-4o",
    keyHint: "GapGPT API key",
  },
];

const PROVIDER_KEY = "remotepal-ai-provider";
const MODEL_KEY = (provider: string) => `remotepal-ai-model-${provider}`;

export function providerDef(id: string): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export function getProvider(): string {
  const p = localStorage.getItem(PROVIDER_KEY);
  return p && PROVIDERS.some((x) => x.id === p) ? p : PROVIDERS[0].id;
}

export function setProvider(id: string): void {
  localStorage.setItem(PROVIDER_KEY, id);
}

export function defaultModelFor(provider: string): string {
  return providerDef(provider).defaultModel;
}

/** Configured model for a provider, or its default if unset. */
export function getModel(provider: string): string {
  return localStorage.getItem(MODEL_KEY(provider)) || defaultModelFor(provider);
}

export function setModel(provider: string, model: string): void {
  const m = model.trim();
  if (!m || m === defaultModelFor(provider)) {
    localStorage.removeItem(MODEL_KEY(provider));
  } else {
    localStorage.setItem(MODEL_KEY(provider), m);
  }
}
