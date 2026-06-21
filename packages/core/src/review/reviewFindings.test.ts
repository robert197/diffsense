import { describe, expect, it, vi } from "vitest";
import type { CodeReference } from "../ports/codeSearch.js";
import type { FindingStore } from "../ports/findingStore.js";
import type { FingerprintCache } from "../ports/fingerprintCache.js";
import type { LLMProvider } from "../ports/llmProvider.js";
import type { ChunkReview } from "../schemas/chunkReview.js";
import type { ReviewFinding } from "../schemas/finding.js";
import { buildReviewChunks, extractSymbols, reviewAndPersistFindings } from "./reviewFindings.js";

const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1,2 +1,3 @@
 const x = 1;
+export function login() {}
 export { x };
diff --git a/src/lib/util.ts b/src/lib/util.ts
--- a/src/lib/util.ts
+++ b/src/lib/util.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

const meta = { owner: "octo", repo: "demo", prNumber: 7 };

function review(file: string): ChunkReview {
  return {
    explanation: `change in ${file}`,
    claims: [{ claim: "claim", evidence: "evidence" }],
    rating: "high",
    reasons: ["touches exported API"],
  };
}

function fakePorts(opts?: { callSites?: CodeReference[] }) {
  const recorded: ReviewFinding[] = [];
  const llm: LLMProvider = {
    reviewChunk: vi.fn(async ({ chunk }) => review(chunk.file)),
    localizeCard: vi.fn(),
    verifyFinding: vi.fn(),
    detectScopeCreep: vi.fn(),
    synthesize: vi.fn(),
  };
  const cache: FingerprintCache = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
  };
  const findingStore: FindingStore = {
    replaceForPr: vi.fn(async (_ref, list: ReviewFinding[]) => {
      recorded.length = 0;
      recorded.push(...list);
    }),
    listByPr: vi.fn(async () => recorded),
  };
  const codeSearch = {
    findCallSites: vi.fn(async () => opts?.callSites ?? []),
    findSymbol: vi.fn(async () => []),
  };
  return { llm, cache, findingStore, codeSearch, tools: [], recorded };
}

describe("buildReviewChunks (#13)", () => {
  it("reconstructs one chunk per hunk with patch text and the ranked tier", () => {
    const chunks = buildReviewChunks(DIFF, meta);
    expect(chunks.map((c) => c.file)).toEqual(["src/auth/login.ts", "src/lib/util.ts"]);
    const auth = chunks.find((c) => c.file === "src/auth/login.ts");
    expect(auth?.tier).toBe("High"); // auth path + exported API
    expect(auth?.patch).toContain("export function login() {}");
  });

  it("returns an empty array for an empty diff", () => {
    expect(buildReviewChunks("", meta)).toEqual([]);
  });
});

describe("extractSymbols (#13)", () => {
  it("captures identifiers declared on added lines only", () => {
    expect(extractSymbols("@@\n+export function login() {}\n const x = 1;")).toEqual(["login"]);
  });

  it("ignores the +++ file header and unchanged lines", () => {
    expect(extractSymbols("+++ b/x.ts\n const keep = 1;")).toEqual([]);
  });
});

describe("reviewAndPersistFindings (#13)", () => {
  it("persists one finding per reviewed chunk with mapped fields and blast radius", async () => {
    const callSites: CodeReference[] = [{ path: "src/app.ts", line: 3, text: "login()" }];
    const ports = fakePorts({ callSites });

    const findings = await reviewAndPersistFindings({ ...meta, diff: DIFF }, ports);

    // Only the High auth chunk is selected for review (margin guard).
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f?.file).toBe("src/auth/login.ts");
    expect(f?.rank).toBe(0);
    expect(f?.explanation).toBe("change in src/auth/login.ts");
    expect(f?.blastRadius).toEqual(["src/app.ts:3 login()"]);
    expect(ports.findingStore.replaceForPr).toHaveBeenCalledOnce();
    expect(ports.recorded).toEqual(findings);
  });

  it("persists a finding with empty blast radius when no call sites match", async () => {
    const ports = fakePorts({ callSites: [] });
    const findings = await reviewAndPersistFindings({ ...meta, diff: DIFF }, ports);
    expect(findings[0]?.blastRadius).toEqual([]);
  });

  it("clears the PR's findings when the diff has no selectable chunks", async () => {
    const ports = fakePorts();
    const findings = await reviewAndPersistFindings({ ...meta, diff: "" }, ports);
    expect(findings).toEqual([]);
    // Replace with an empty set so a reverted PR drops its stale cards.
    expect(ports.findingStore.replaceForPr).toHaveBeenCalledOnce();
    expect(ports.recorded).toEqual([]);
  });
});
