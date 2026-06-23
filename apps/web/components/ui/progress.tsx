import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * A purely-decorative progress track with an eased fill. `value` is a clamped
 * percent (0–100). Where accessibility matters (the deck), callers pair this with a
 * visually-hidden native `<progress>` carrying the real semantics.
 */
export function Progress({
  value,
  indicatorClassName,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { value: number; indicatorClassName?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-secondary", className)}
      {...props}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-300 ease-out",
          indicatorClassName,
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
