"use client";

import { RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "../components/ui/button";

/**
 * App-level error boundary (issue #25). Server components in the entry path
 * (repos / pulls) read GitHub at render time; a GitHub outage, rate limit, or
 * timeout throws. Without a boundary Next renders a bare 500 with no recovery —
 * this gives the reviewer a readable message and a retry instead. Advisory
 * product: no merge/approve controls here either.
 */
export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-16">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 grid size-12 place-items-center rounded-full border border-destructive/40 bg-destructive/10 text-destructive">
          <TriangleAlert className="size-6" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mx-auto mt-2 max-w-sm leading-relaxed text-muted-foreground">
          We couldn&apos;t reach GitHub just now — it may be rate-limiting or temporarily
          unavailable. Try again in a moment.
        </p>
        <div className="mt-6 flex flex-col items-center gap-3">
          <Button type="button" onClick={() => reset()}>
            <RotateCw />
            Try again
          </Button>
          <a href="/repos" className="text-sm text-muted-foreground hover:text-foreground">
            Back to repositories
          </a>
        </div>
      </div>
    </main>
  );
}
