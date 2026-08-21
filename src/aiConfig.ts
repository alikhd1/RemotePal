// AI provider registry. Two built-in providers plus any the user defines
// (custom OpenAI-compatible endpoints). The active provider, the custom
// list, and per-provider model overrides live in localStorage so the
// setting reaches the AiPanel docked in a terminal. API keys never live
// here — they're in the OS keyring (backend), one per provider id.

export type ProviderKind = "anthropic" | "openai";

export interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  /** required for kind "openai" — the Chat Completions endpoint */
  baseUrl?: string;
  defaultModel: string;
  builtin?: boolean;
  /** false for local runtimes (Ollama) that need no API key */
  requiresKey?: boolean;
}

// Every provider below except Anthropic speaks the OpenAI Chat
// Completions protocol, so they all run through the same adapter — only
// the endpoint and default model differ. Models are editable per
// provider in the settings card.
const BUILTINS: ProviderDef[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    defaultModel: "claude-opus-5",
    builtin: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o",
    builtin: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/chat/completions",
    defaultModel: "deepseek-chat",
    builtin: true,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "openai",
    // Google's OpenAI-compatible surface
    baseUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModel: "gemini-2.0-flash",
    builtin: true,
  },
  {
    id: "grok",
    label: "xAI Grok",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1/chat/completions",
    defaultModel: "grok-2-latest",
    builtin: true,
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "llama-3.3-70b-versatile",
    builtin: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "openai/gpt-4o",
    builtin: true,
  },
  {
    id: "gapgpt",
    label: "GapGPT",
    kind: "openai",
    baseUrl: "https://api.gapgpt.app/v1/chat/completions",
    defaultModel: "gpt-4o",
    builtin: true,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1/chat/completions",
    defaultModel: "llama3.1",
    builtin: true,
    requiresKey: false,
  },
];

const PROVIDER_KEY = "remotepal-ai-provider";
const CUSTOM_KEY = "remotepal-ai-providers";
const MODEL_KEY = (provider: string) => `remotepal-ai-model-${provider}`;

function getCustom(): ProviderDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // custom providers are always OpenAI-compatible
    return list
      .filter((p) => p && p.id && p.label && p.baseUrl)
      .map((p) => ({
        id: String(p.id),
        label: String(p.label),
        kind: "openai" as const,
        baseUrl: String(p.baseUrl),
        defaultModel: String(p.defaultModel || "gpt-4o"),
      }));
  } catch {
    return [];
  }
}

function saveCustom(list: ProviderDef[]): void {
  localStorage.setItem(
    CUSTOM_KEY,
    JSON.stringify(
      list.map((p) => ({
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        defaultModel: p.defaultModel,
      })),
    ),
  );
}

/** All providers: built-ins first, then user-defined. */
export function getProviders(): ProviderDef[] {
  return [...BUILTINS, ...getCustom()];
}

export function providerDef(id: string): ProviderDef {
  return getProviders().find((p) => p.id === id) ?? BUILTINS[0];
}

/** Add a custom OpenAI-compatible provider; returns its generated id. */
export function addCustomProvider(input: {
  label: string;
  baseUrl: string;
  defaultModel?: string;
}): string {
  const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
  const def: ProviderDef = {
    id,
    label: input.label.trim() || "Custom",
    kind: "openai",
    baseUrl: input.baseUrl.trim(),
    defaultModel: (input.defaultModel || "gpt-4o").trim(),
  };
  saveCustom([...getCustom(), def]);
  return id;
}

export function removeCustomProvider(id: string): void {
  saveCustom(getCustom().filter((p) => p.id !== id));
  localStorage.removeItem(MODEL_KEY(id));
  if (getProvider() === id) setProvider(BUILTINS[0].id);
}

export function getProvider(): string {
  const p = localStorage.getItem(PROVIDER_KEY);
  return p && getProviders().some((x) => x.id === p) ? p : BUILTINS[0].id;
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
