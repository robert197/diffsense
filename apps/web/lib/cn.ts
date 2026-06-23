import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class lists and resolve Tailwind conflicts (last wins). The
 * standard shadcn helper, shared by the `components/ui` primitives and any caller
 * composing classes on top of them.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
