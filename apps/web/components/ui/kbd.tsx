import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** A keyboard-key chip — used to advertise the deck's ←/→ shortcuts, dev-tool style. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded border border-border-strong bg-secondary px-1.5 py-0.5 font-mono text-[0.7rem] font-medium leading-none text-muted-foreground shadow-[0_1px_0_0_rgba(0,0,0,0.4)]",
        className,
      )}
      {...props}
    />
  );
}
