/**
 * Cross-surface UI helpers shared by the deck, findings list, and dashboard.
 *
 * The big idea the product sells is *attention allocation by risk* — so a risk tier
 * must read identically everywhere. `TIER_META` is the single source for a tier's
 * label, colour, and the Tailwind classes its chip/meter use; `TIER_COLOR` keeps the
 * raw accent for the few inline cases (the code-window highlight rail). `relativeTime`
 * formats the "3h ago" labels on PR and review rows.
 */

export type Tier = "High" | "Medium" | "Low";

/** Raw accent colour per tier — for inline styles (e.g. the code highlight rail). */
export const TIER_COLOR: Record<string, string> = {
  High: "#f0616d",
  Medium: "#f5b53d",
  Low: "#8fa1ba",
};

export interface TierMeta {
  label: string;
  /** Risk-meter fill (%) — derived from the tier bucket, so it reads right at any score scale. */
  meterPct: number;
  /** Chip classes: tinted fill + accent text + hairline border. */
  chip: string;
  /** Accent text colour utility. */
  text: string;
  /** Accent meter-fill background utility. */
  fill: string;
  /** Left accent-rail border utility for cards. */
  rail: string;
  /** One-word framing of what the tier asks of the reviewer. */
  blurb: string;
}

export const TIER_META: Record<Tier, TierMeta> = {
  High: {
    label: "High risk",
    meterPct: 92,
    chip: "bg-tier-high-fill text-tier-high border-tier-high/30",
    text: "text-tier-high",
    fill: "bg-tier-high",
    rail: "border-l-tier-high",
    blurb: "Read this closely",
  },
  Medium: {
    label: "Medium risk",
    meterPct: 56,
    chip: "bg-tier-medium-fill text-tier-medium border-tier-medium/30",
    text: "text-tier-medium",
    fill: "bg-tier-medium",
    rail: "border-l-tier-medium",
    blurb: "Worth a look",
  },
  Low: {
    label: "Low risk",
    meterPct: 24,
    chip: "bg-tier-low-fill text-tier-low border-tier-low/30",
    text: "text-tier-low",
    fill: "bg-tier-low",
    rail: "border-l-tier-low",
    blurb: "Skim it",
  },
};

/**
 * Normalise a tier value to the canonical `High`/`Medium`/`Low`. The deck schema
 * emits capitalised tiers, but the findings store holds free-form strings (seed and
 * older rows use lowercase), so every surface routes through this to read the same
 * colour and label regardless of casing.
 */
export function normalizeTier(tier: string): Tier {
  const t = tier.trim().toLowerCase();
  if (t === "high") return "High";
  if (t === "medium") return "Medium";
  return "Low";
}

/** Tier metadata, case-insensitive, with a safe fallback for any unexpected value. */
export function tierMeta(tier: string): TierMeta {
  return TIER_META[normalizeTier(tier)];
}

/** Compact relative-time label ("3h ago"). Falls back to the raw value. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }
  const seconds = Math.round((now - then) / 1000);
  const units: Array<[string, number]> = [
    ["y", 31536000],
    ["mo", 2592000],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ];
  for (const [label, size] of units) {
    const value = Math.floor(seconds / size);
    if (value >= 1) {
      return `${value}${label} ago`;
    }
  }
  return "just now";
}
