import type { CSSProperties } from "react";

/**
 * Shared mobile-first styles for the entry-path screens (issue #25). A single
 * centered column that reads well at ~360px and scales to desktop; rows are
 * full-width with ≥44px touch targets. Inline styles match the existing surface
 * (`app/layout.tsx`, `app/page.tsx`); no CSS framework is introduced.
 */

export const page: CSSProperties = {
  maxWidth: 640,
  margin: "0 auto",
  padding: "1.5rem 1.25rem 3rem",
};

export const list: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gap: "0.6rem",
};

/** A tappable navigation row (repo or PR). Block-level link, large hit area. */
export const row: CSSProperties = {
  display: "block",
  minHeight: 44,
  padding: "0.85rem 1rem",
  border: "1px solid #1f2933",
  borderRadius: 10,
  background: "#11151a",
  color: "#e6e8eb",
  textDecoration: "none",
};

export const muted: CSSProperties = {
  opacity: 0.6,
  fontSize: "0.85rem",
};

/**
 * Risk-tier accent colours, shared by the findings list (#13) and the swipe deck
 * (#27) so a tier always reads the same colour across surfaces. Keyed by the
 * `Tier` enum the ranking emits ("High" | "Medium" | "Low").
 */
export const TIER_COLOR: Record<string, string> = {
  High: "#f87171",
  Medium: "#fbbf24",
  Low: "#9ca3af",
};

export const badge: CSSProperties = {
  fontSize: "0.65rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  borderRadius: 999,
  padding: "0.1rem 0.5rem",
  border: "1px solid #374151",
  opacity: 0.8,
};

export const primaryButton: CSSProperties = {
  display: "inline-block",
  padding: "0.7rem 1.1rem",
  borderRadius: 8,
  background: "#2563eb",
  color: "#fff",
  fontWeight: 600,
  textDecoration: "none",
  border: "none",
  cursor: "pointer",
  fontSize: "1rem",
};

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
