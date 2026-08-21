// Per-provider badges for the AI provider pickers.
//
// Each provider gets a rounded badge in its own brand colour so the
// entries are told apart at a glance. Where a vendor's mark is simple
// geometry we draw it (Gemini's four-point star, xAI's X, the Claude
// burst); the rest carry a monogram, because approximating an intricate
// logo (OpenAI's knot, Ollama's llama, DeepSeek's whale) from memory
// produces something worse than a clean letterform. Drop official SVGs
// in here if you want exact marks — nothing else needs to change.
//
// Everything is inline SVG: no network requests, no bundled assets.

interface Brand {
  color: string;
  /** monogram used when there is no drawn mark */
  letter?: string;
  mark?: "burst" | "star" | "x";
}

const BRANDS: Record<string, Brand> = {
  anthropic: { color: "#D97757", mark: "burst" },
  openai: { color: "#10A37F", letter: "O" },
  deepseek: { color: "#4D6BFE", letter: "D" },
  gemini: { color: "#4285F4", mark: "star" },
  grok: { color: "#4B5563", mark: "x" },
  groq: { color: "#F55036", letter: "G" },
  openrouter: { color: "#6467F2", letter: "R" },
  gapgpt: { color: "#0EA5E9", letter: "G" },
  ollama: { color: "#6B7280", letter: "L" },
};

const FALLBACK: Brand = { color: "#8B8B8B" };

function markFor(brand: Brand, letter: string) {
  switch (brand.mark) {
    case "star":
      // four-point sparkle
      return (
        <path
          d="M12 4.5c.5 3.9 2.6 6 6.5 6.5-3.9.5-6 2.6-6.5 6.5-.5-3.9-2.6-6-6.5-6.5 3.9-.5 6-2.6 6.5-6.5z"
          fill="#fff"
        />
      );
    case "x":
      return (
        <path
          d="M7.5 6.5l9 11M16.5 6.5l-9 11"
          stroke="#fff"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
      );
    case "burst":
      // radiating spokes, in the spirit of the Claude mark
      return (
        <g stroke="#fff" strokeWidth="1.9" strokeLinecap="round">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
          <path d="M7 7l10 10" />
          <path d="M17 7L7 17" />
        </g>
      );
    default:
      return (
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
      );
  }
}

interface Props {
  /** provider id from aiConfig */
  id: string;
  /** used for the monogram of user-defined providers */
  label?: string;
  size?: number;
}

function ProviderIcon({ id, label, size = 14 }: Props) {
  const brand = BRANDS[id] ?? FALLBACK;
  const letter =
    brand.letter ?? (label?.trim()?.[0] ?? id[0] ?? "?").toUpperCase();

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect width="24" height="24" rx="6" fill={brand.color} />
      {markFor(brand, letter)}
    </svg>
  );
}

export default ProviderIcon;
