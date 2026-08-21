// Real provider logos for the AI provider pickers.
//
// The SVGs in ./assets/providers are LobeHub's icon set
// (https://lobehub.com/icons), downloaded and committed rather than
// pulled at runtime — nothing here touches the network.
//
// They are inlined with `?raw` instead of being used as <img src>, so the
// monochrome marks (which are authored with fill="currentColor") pick up
// the theme's foreground colour and stay visible on both light and dark.
// The markup is a static, reviewed asset in this repo, not remote or user
// input. Providers with no upstream logo (GapGPT, anything you define
// yourself) fall back to a brand-coloured monogram badge.

import anthropicSvg from "./assets/providers/anthropic.svg?raw";
import deepseekSvg from "./assets/providers/deepseek.svg?raw";
import geminiSvg from "./assets/providers/gemini.svg?raw";
import grokSvg from "./assets/providers/grok.svg?raw";
import groqSvg from "./assets/providers/groq.svg?raw";
import ollamaSvg from "./assets/providers/ollama.svg?raw";
import openaiSvg from "./assets/providers/openai.svg?raw";
import openrouterSvg from "./assets/providers/openrouter.svg?raw";

const LOGOS: Record<string, string> = {
  anthropic: anthropicSvg,
  deepseek: deepseekSvg,
  gemini: geminiSvg,
  grok: grokSvg,
  groq: groqSvg,
  ollama: ollamaSvg,
  openai: openaiSvg,
  openrouter: openrouterSvg,
};

/// Marks drawn in currentColor; these follow the theme instead of a
/// fixed brand colour (which is how the vendors intend them to be used).
const MONO = new Set(["openai", "grok", "groq", "openrouter", "ollama"]);

/// Badge colours for providers with no upstream logo.
const FALLBACK_COLORS: Record<string, string> = {
  gapgpt: "#0EA5E9",
};

interface Props {
  /** provider id from aiConfig */
  id: string;
  /** used for the monogram when there is no logo */
  label?: string;
  size?: number;
}

function ProviderIcon({ id, label, size = 18 }: Props) {
  const logo = LOGOS[id];

  if (logo) {
    // the files size themselves in em, so the wrapper's font-size is the
    // single knob that scales them
    return (
      <span
        className={"provider-icon" + (MONO.has(id) ? " mono" : "")}
        style={{ fontSize: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: logo }}
      />
    );
  }

  const color = FALLBACK_COLORS[id] ?? "#8B8B8B";
  const letter = (label?.trim()?.[0] ?? id[0] ?? "?").toUpperCase();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect width="24" height="24" rx="6" fill={color} />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fff"
        fontSize="12"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
      >
        {letter}
      </text>
    </svg>
  );
}

export default ProviderIcon;
