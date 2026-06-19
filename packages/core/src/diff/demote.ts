/**
 * Path/extension demotion heuristic — pure, deterministic, no I/O.
 *
 * Generated, binary, and lockfile changes are machine-written: large but rarely
 * worth a reviewer's first attention. `classifyDemotion` flags them by path so
 * `rankHunks` can force them to Low and keep them out of the "review first" set
 * even when they are large (docs/ARCHITECTURE.md §2 — the ranking is cost and
 * attention control). Returns the matched reason, or null for a real change.
 */

export type DemotionReason = "generated" | "binary" | "lockfile";

// First match wins, so order matters: lockfiles and generated artifacts are
// checked before the broad binary-extension catch-all.
const DEMOTION_PATTERNS: ReadonlyArray<readonly [DemotionReason, RegExp]> = [
  [
    "lockfile",
    /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|cargo\.lock|poetry\.lock|gemfile\.lock|composer\.lock|go\.sum|pipfile\.lock)$|\.lock$/i,
  ],
  [
    "generated",
    /\.min\.(js|css)$|\.(js|css)\.map$|(^|\/)(dist|build|vendor|node_modules|generated)\/|\.generated\.[^/]+$|\.pb\.go$|_pb2\.py$|\.snap$/i,
  ],
  [
    "binary",
    /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|svgz|woff2?|ttf|eot|otf|zip|gz|tgz|tar|7z|rar|pdf|wasm|bin|exe|dll|so|dylib|class|jar|mp4|mov|mp3|wav|ogg)$/i,
  ],
];

/**
 * Classify a file path as machine-written noise, or null if it is a real change
 * a reviewer should see ranked on its merits.
 */
export function classifyDemotion(path: string): DemotionReason | null {
  for (const [reason, pattern] of DEMOTION_PATTERNS) {
    if (pattern.test(path)) {
      return reason;
    }
  }
  return null;
}
