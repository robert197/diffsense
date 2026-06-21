"use client";

import { primaryButton } from "../lib/ui";

/**
 * App-level error boundary (issue #25). Server components in the entry path
 * (repos / pulls) read GitHub at render time; a GitHub outage, rate limit, or
 * timeout throws. Without a boundary Next renders a bare 500 with no recovery —
 * this gives the reviewer a readable message and a retry instead. Advisory
 * product: no merge/approve controls here either.
 */
export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: "2rem" }}>
      <div style={{ maxWidth: 460, width: "100%", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.4rem", marginBottom: "0.5rem" }}>Something went wrong</h1>
        <p style={{ opacity: 0.7, lineHeight: 1.5, marginBottom: "1.5rem" }}>
          We couldn&apos;t reach GitHub just now — it may be rate-limiting or temporarily
          unavailable. Try again in a moment.
        </p>
        <div style={{ display: "grid", gap: "0.75rem", justifyItems: "center" }}>
          <button type="button" onClick={() => reset()} style={primaryButton}>
            Try again
          </button>
          <a href="/repos" style={{ color: "#9ca3af", fontSize: "0.85rem" }}>
            Back to repositories
          </a>
        </div>
      </div>
    </main>
  );
}
