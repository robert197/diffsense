import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { SignOutButton } from "../SignOutButton";
import { Logo } from "./Logo";

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * The signed-in app chrome: a sticky top bar with the wordmark (→ home), a
 * breadcrumb trail for orientation in deep PR routes, and sign-out. Kept server-only
 * and prop-driven so every inner page shares one consistent header. Advisory product
 * — no merge/approve controls live here.
 */
export function AppHeader({ crumbs = [], login }: { crumbs?: Crumb[]; login?: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
        <a href="/repos" className="rounded-md focus-visible:outline-2 focus-visible:outline-ring">
          <Logo />
        </a>

        {crumbs.length > 0 && (
          <nav
            aria-label="Breadcrumb"
            className="hidden min-w-0 items-center gap-1.5 text-sm text-muted-foreground sm:flex"
          >
            {crumbs.map((c, i) => (
              <Fragment key={`${c.label}-${i}`}>
                <ChevronRight className="size-3.5 shrink-0 opacity-50" aria-hidden />
                {c.href ? (
                  <a
                    href={c.href}
                    className="truncate rounded transition-colors hover:text-foreground"
                  >
                    {c.label}
                  </a>
                ) : (
                  <span className="truncate font-medium text-foreground">{c.label}</span>
                )}
              </Fragment>
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-3">
          {login && (
            <span className="hidden text-sm text-muted-foreground sm:inline">@{login}</span>
          )}
          <SignOutButton variant="pill" />
        </div>
      </div>
    </header>
  );
}
