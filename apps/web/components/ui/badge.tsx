import { type VariantProps, cva } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** Small status pill. `outline` is the quiet default; semantic variants for state. */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.7rem] font-semibold leading-none [&_svg]:size-3",
  {
    variants: {
      variant: {
        outline: "border-border bg-transparent text-muted-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        success: "border-success/40 bg-success/10 text-success",
        danger: "border-destructive/40 bg-destructive/10 text-destructive",
        warning: "border-tier-medium/40 bg-tier-medium-fill text-tier-medium",
        primary: "border-primary/40 bg-primary/10 text-primary",
      },
    },
    defaultVariants: { variant: "outline" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
