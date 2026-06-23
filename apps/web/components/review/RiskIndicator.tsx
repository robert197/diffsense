import { Info, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "../../lib/cn";
import { type Tier, normalizeTier, tierMeta } from "../../lib/ui";

const TIER_ICON: Record<Tier, ComponentType<{ className?: string }>> = {
  High: ShieldAlert,
  Medium: TriangleAlert,
  Low: Info,
};

/**
 * The tier chip — the bucketed risk signal, identical on every surface. Shows the
 * canonical tier word (`High`/`Medium`/`Low`) with its icon and accent so a reviewer
 * reads severity at a glance before any prose. Case-insensitive on the input.
 */
export function TierBadge({ tier, className }: { tier: string; className?: string }) {
  const t = normalizeTier(tier);
  const m = tierMeta(t);
  const Icon = TIER_ICON[t];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold leading-none",
        m.chip,
        className,
      )}
    >
      <Icon className="size-3.5" />
      {t}
    </span>
  );
}

/**
 * The risk meter — the precise structural score, rendered as a tier-tinted bar plus
 * the exact value. The bar fill is bucketed by tier so it reads correctly at any raw
 * score scale; the number carries the precision. This is the signal the whole product
 * exists to surface, so it gets prominent, tabular treatment.
 */
export function RiskMeter({ tier, score }: { tier: string; score: number }) {
  const m = tierMeta(tier);
  return (
    <div className="flex w-28 shrink-0 flex-col items-end gap-1.5">
      <span className={cn("text-[0.7rem] font-semibold uppercase tracking-wider", m.text)}>
        {m.label}
      </span>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full rounded-full", m.fill)} style={{ width: `${m.meterPct}%` }} />
      </div>
      <span className="font-mono text-[0.7rem] tabular-nums text-muted-foreground">
        risk {score.toFixed(1)}
      </span>
    </div>
  );
}
