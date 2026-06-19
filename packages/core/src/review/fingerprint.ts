import { createHash } from "node:crypto";

/**
 * Structural fingerprint of a chunk — the key into the `FingerprintCache`
 * (docs/ARCHITECTURE.md §5). Pure and deterministic.
 *
 * It hashes the file path plus the chunk's changed lines, normalized so the key
 * is stable across cosmetic noise:
 * - only added/removed lines count (hunk headers and context are dropped, so the
 *   key is independent of *where* the change sits — line numbers live in the
 *   `@@` header, which is never a `+`/`-` line);
 * - leading +/- markers are kept (an add vs a delete of the same text differ);
 * - inner whitespace is collapsed and the line trimmed (reformatting alone does
 *   not bust the cache).
 *
 * So the same change recurring elsewhere in the file reuses its cached review,
 * while a different change — or the same change in another file — gets a fresh
 * key.
 */
export function fingerprintChunk(file: string, patch: string): string {
  const normalized = patch
    .split("\n")
    .filter((line) => line.startsWith("+") || line.startsWith("-"))
    // Drop file headers (`+++ b/...`, `--- a/...`) — they carry no change content.
    .filter((line) => !line.startsWith("+++") && !line.startsWith("---"))
    .map((line) => `${line[0]}${line.slice(1).trim().replace(/\s+/g, " ")}`)
    // Keep only lines that still carry content after trimming.
    .filter((line) => line.length > 1)
    .join("\n");
  return createHash("sha256").update(`${file}\n${normalized}`).digest("hex").slice(0, 32);
}
