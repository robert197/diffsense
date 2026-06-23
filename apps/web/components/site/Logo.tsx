import { ScanSearch } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * The diffsense wordmark: a gradient tile (the "lens" that finds risk) + the name.
 * `size="sm"` for headers, `lg` for the landing hero. Icon-only when `wordmark` is off.
 */
export function Logo({
  size = "sm",
  wordmark = true,
  className,
}: {
  size?: "sm" | "lg";
  wordmark?: boolean;
  className?: string;
}) {
  const lg = size === "lg";
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        className={cn(
          "grid place-items-center rounded-lg bg-gradient-to-br from-primary to-[#8b5cf6] text-primary-foreground shadow-sm",
          lg ? "size-11" : "size-8",
        )}
      >
        <ScanSearch className={lg ? "size-6" : "size-[1.1rem]"} strokeWidth={2.25} />
      </span>
      {wordmark && (
        <span className={cn("font-semibold tracking-tight", lg ? "text-2xl" : "text-base")}>
          diffsense
        </span>
      )}
    </span>
  );
}
