import parseDiff from "parse-diff";
import type { CodeSearch } from "../ports/codeSearch.js";
import type { FindingStore } from "../ports/findingStore.js";
import type { FingerprintCache } from "../ports/fingerprintCache.js";
import type { LLMProvider } from "../ports/llmProvider.js";
import { type PrMeta, rankHunks } from "../rank/rankHunks.js";
import type { ReviewFinding } from "../schemas/finding.js";
import { type ReviewChunk, reviewChunks } from "./reviewPass.js";
import { toFindings } from "./toFindings.js";
import type { AnyReviewTool } from "./tools.js";

/**
 * The agentic review producer the worker runs when an LLM is configured (issues
 * #8 + #13). The deterministic ranked comment ships regardless; this runs the
 * bounded review unit over the risk-selected chunks and persists a
 * `ReviewFinding` per reviewed chunk, so the hosted card view (#13) has data.
 *
 * Pure orchestration over injected ports — fully unit-testable with fakes, no
 * network, no vendor SDK (CLAUDE.md). Verify/scope/synthesis (#9/#10/#11) are
 * deliberately not in this path: the card is the per-chunk review view.
 */

/** Cap on how many call-site references a finding's blast radius lists. */
const MAX_BLAST_RADIUS = 10;
/** Cap on how many symbols per chunk we probe for call sites. */
const MAX_SYMBOLS_PER_CHUNK = 3;

/** A changed line that declares a symbol — captures the declared identifier. */
const DEFINITION = /(?:function|class|const|let|var|def|func|type|interface)\s+([A-Za-z_$][\w$]*)/;

export interface ReviewFindingsPorts {
  llm: LLMProvider;
  cache: FingerprintCache;
  findingStore: FindingStore;
  codeSearch: CodeSearch;
  tools: readonly AnyReviewTool[];
}

export interface ReviewFindingsContext {
  owner: string;
  repo: string;
  prNumber: number;
  diff: string;
}

/**
 * Reconstruct the review chunks from a unified diff, each tagged with the
 * structural tier the ranking assigned it (the tier drives both selection and
 * model routing inside `reviewChunks`).
 */
export function buildReviewChunks(diff: string, meta: PrMeta): ReviewChunk[] {
  if (!diff.trim()) {
    return [];
  }

  // Tier per hunk, keyed the same way `rankHunks` derives its deep-link anchor.
  const tierByKey = new Map<string, ReviewChunk["tier"]>();
  for (const ranked of rankHunks(diff, meta)) {
    tierByKey.set(`${ranked.file}\n${ranked.side}\n${ranked.line}`, ranked.tier);
  }

  const chunks: ReviewChunk[] = [];
  for (const file of parseDiff(diff)) {
    const path = githubPath(file);
    if (!path) {
      continue;
    }
    for (const chunk of file.chunks ?? []) {
      let added = 0;
      for (const change of chunk.changes) {
        if (change.type === "add") added++;
      }
      const side = added > 0 ? "R" : "L";
      const line = added > 0 ? chunk.newStart : chunk.oldStart;
      const patch = [chunk.content, ...chunk.changes.map((c) => c.content)].join("\n");
      chunks.push({
        file: path,
        tier: tierByKey.get(`${path}\n${side}\n${line}`) ?? "Low",
        patch,
      });
    }
  }
  return chunks;
}

/**
 * Run the review pass and persist one finding per reviewed chunk. Returns the
 * persisted findings (also handy for tests). Blast radius is resolved here:
 * identifiers declared in the chunk are looked up via `CodeSearch`, bounded and
 * forgiving (an unresolved symbol yields nothing, never throws).
 */
export async function reviewAndPersistFindings(
  ctx: ReviewFindingsContext,
  ports: ReviewFindingsPorts,
): Promise<ReviewFinding[]> {
  const { owner, repo, prNumber, diff } = ctx;
  const chunks = buildReviewChunks(diff, { owner, repo, prNumber });

  const results = await reviewChunks(chunks, {
    llm: ports.llm,
    cache: ports.cache,
    tools: ports.tools,
    repo: { owner, repo },
  });

  const blastRadius = new Map<string, string[]>();
  for (const result of results) {
    blastRadius.set(result.fingerprint, await resolveBlastRadius(result.chunk, ports.codeSearch));
  }

  const findings = toFindings(results, { owner, repo, prNumber, blastRadius });
  for (const finding of findings) {
    await ports.findingStore.record(finding);
  }
  return findings;
}

/** Look up call sites of the symbols a chunk declares; bounded and forgiving. */
async function resolveBlastRadius(chunk: ReviewChunk, codeSearch: CodeSearch): Promise<string[]> {
  const references: string[] = [];
  for (const symbol of extractSymbols(chunk.patch)) {
    if (references.length >= MAX_BLAST_RADIUS) break;
    const sites = await codeSearch.findCallSites(symbol);
    for (const site of sites) {
      references.push(`${site.path}:${site.line} ${site.text}`);
      if (references.length >= MAX_BLAST_RADIUS) break;
    }
  }
  return references;
}

/** Identifiers an added line of the chunk declares — the blast-radius probes. */
export function extractSymbols(patch: string): string[] {
  const symbols = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }
    const match = DEFINITION.exec(line.slice(1));
    if (match?.[1]) {
      symbols.add(match[1]);
    }
    if (symbols.size >= MAX_SYMBOLS_PER_CHUNK) {
      break;
    }
  }
  return [...symbols];
}

/** The path GitHub uses for the file: the new path, or the old one if deleted. */
function githubPath(file: parseDiff.File): string | null {
  const to = file.to && file.to !== "/dev/null" ? file.to : null;
  const from = file.from && file.from !== "/dev/null" ? file.from : null;
  return to ?? from;
}
