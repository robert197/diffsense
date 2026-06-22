import type { Deck, DeckStore, ReviewFinding } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../adapters/github.js";
import type { Database } from "../db/client.js";
import type { PrRef } from "../types.js";
import type { ReviewSupport, RunReviewResult } from "../worker/reviewRunner.js";
import type { CliConfig } from "./config.js";
import { CliConfigError } from "./errors.js";
import {
  type GitHubAppLike,
  type ReviewCommandDeps,
  type ReviewIo,
  parseReviewArgs,
  runReviewCommand,
} from "./review.js";

const cfg: CliConfig = {
  githubAppId: "1",
  githubPrivateKey: "k",
  databaseUrl: "postgres://u:p@localhost:5432/db",
};

function makeDeck(): Deck {
  return {
    owner: "octo-org",
    repo: "demo",
    prNumber: 42,
    headSha: "abc123",
    cards: [
      {
        fingerprint: "fp-0",
        file: "src/auth.ts",
        tier: "High",
        rank: 0,
        riskScore: 9.5,
        highlights: [{ side: "R", start: 2, end: 2 }],
        suggestions: ["check token expiry"],
        explanation: "Adds a token check.",
      },
      {
        fingerprint: "fp-1",
        file: "src/util.ts",
        tier: "Low",
        rank: 1,
        riskScore: 1,
        highlights: [{ side: "R", start: 11, end: 11 }],
        suggestions: [],
        explanation: "Adds a log line.",
      },
    ],
  };
}

const finding: ReviewFinding = {
  owner: "octo-org",
  repo: "demo",
  prNumber: 42,
  fingerprint: "fp-0",
  file: "src/auth.ts",
  tier: "High",
  rank: 0,
  explanation: "Adds a token check.",
  claims: [],
  reasons: ["auth-sensitive"],
  blastRadius: [],
};

interface Harness {
  deps: ReviewCommandDeps;
  io: ReviewIo;
  out: string[];
  err: string[];
  getRepoInstallation: ReturnType<typeof vi.fn>;
  createApp: ReturnType<typeof vi.fn>;
  openDb: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  runReviewForRef: ReturnType<typeof vi.fn>;
}

function makeHarness(
  over: {
    loadConfig?: ReviewCommandDeps["loadConfig"];
    getRepoInstallationImpl?: (p: { owner: string; repo: string }) => Promise<{
      data: { id: number };
    }>;
    deck?: Deck | null;
    findings?: readonly ReviewFinding[];
    reviewSupport?: ReviewSupport | null;
    runResult?: RunReviewResult;
    runImpl?: () => Promise<RunReviewResult>;
    closeImpl?: () => Promise<void>;
  } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const io: ReviewIo = { stdout: (l) => out.push(l), stderr: (l) => err.push(l) };

  const getRepoInstallation = vi.fn(
    over.getRepoInstallationImpl ?? (async () => ({ data: { id: 55 } })),
  );
  const fakeOctokit = { rest: {} } as unknown as GitHubClient;
  const app: GitHubAppLike = {
    octokit: { rest: { apps: { getRepoInstallation } } },
    getInstallationOctokit: vi.fn(async () => fakeOctokit),
  };
  const createApp = vi.fn(() => app);

  const deckStore: DeckStore = {
    save: vi.fn(async () => {}),
    get: vi.fn(async () => (over.deck === undefined ? makeDeck() : over.deck)),
  };
  const close = vi.fn(over.closeImpl ?? (async () => {}));
  const openDb = vi.fn(() => ({ db: {} as Database, close }));
  const runReviewForRef = vi.fn(
    over.runImpl ??
      (async (): Promise<RunReviewResult> =>
        over.runResult ?? {
          headSha: "abc123",
          upsert: { action: "created", commentId: 999 },
          findings: over.findings ?? [finding],
        }),
  );

  const deps: ReviewCommandDeps = {
    env: {},
    loadConfig: over.loadConfig ?? (() => cfg),
    createApp,
    openDb,
    createDeckStore: () => deckStore,
    buildReviewSupport: () =>
      over.reviewSupport === undefined
        ? ({ makeRunner: vi.fn() } as ReviewSupport)
        : over.reviewSupport,
    runReviewForRef,
    newDeliveryId: () => "fixed-id",
  };

  return { deps, io, out, err, getRepoInstallation, createApp, openDb, close, runReviewForRef };
}

describe("parseReviewArgs (#32 U5)", () => {
  it("parses a bare pr-ref", () => {
    expect(parseReviewArgs(["o/r#1"])).toEqual({ prRef: "o/r#1" });
  });
  it("parses --installation-id <n>", () => {
    expect(parseReviewArgs(["o/r#1", "--installation-id", "7"])).toEqual({
      prRef: "o/r#1",
      installationId: 7,
    });
  });
  it("parses --installation-id=<n> and tolerates --json", () => {
    expect(parseReviewArgs(["--json", "o/r#1", "--installation-id=7"])).toEqual({
      prRef: "o/r#1",
      installationId: 7,
    });
  });
  it("throws on a missing pr-ref", () => {
    expect(() => parseReviewArgs([])).toThrow(/Missing <pr-ref>/);
  });
  it("throws on an unknown flag", () => {
    expect(() => parseReviewArgs(["o/r#1", "--bogus"])).toThrow(/Unknown flag/);
  });
  it("throws on a non-integer installation id", () => {
    expect(() => parseReviewArgs(["o/r#1", "--installation-id", "x"])).toThrow(/positive integer/);
  });
  it("throws a clear error when --installation-id has no value (trailing flag)", () => {
    expect(() => parseReviewArgs(["o/r#1", "--installation-id"])).toThrow(/requires a value/);
  });
  it("throws when --installation-id is followed by another flag, not a value", () => {
    expect(() => parseReviewArgs(["o/r#1", "--installation-id", "--json"])).toThrow(
      /requires a value/,
    );
  });
});

describe("runReviewCommand (#32 U5)", () => {
  it("happy path: emits exactly one JSON object with deck + findings, returns 0, closes db", async () => {
    const h = makeHarness();
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.out).toHaveLength(1);
    const parsed = JSON.parse(h.out[0] as string);
    expect(parsed).toMatchObject({
      pr: { owner: "octo-org", repo: "demo", prNumber: 42 },
      headSha: "abc123",
      comment: { action: "created", commentId: 999 },
      llm: true,
    });
    expect(parsed.deck.cards).toHaveLength(2);
    expect(parsed.findings).toHaveLength(1);
    // installation resolved from the repo (no flag/env id), one review run.
    expect(h.getRepoInstallation).toHaveBeenCalledOnce();
    expect(h.runReviewForRef).toHaveBeenCalledOnce();
    // The db handle is always closed.
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("findings come from the run, not a store read-back (deck and findings agree on the run)", async () => {
    const h = makeHarness({
      runResult: {
        headSha: "abc123",
        upsert: { action: "updated", commentId: 7 },
        findings: [finding],
      },
    });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.out[0] as string);
    expect(parsed.findings).toEqual([finding]);
    expect(parsed.comment).toEqual({ action: "updated", commentId: 7 });
  });

  it("LLM-off: reports llm:false with empty findings but still emits the deck, returns 0", async () => {
    const h = makeHarness({ reviewSupport: null, findings: [] });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.out[0] as string);
    expect(parsed.llm).toBe(false);
    expect(parsed.findings).toEqual([]);
    expect(parsed.deck.cards).toHaveLength(2);
  });

  it("emits deck:null when the head SHA could not be resolved", async () => {
    const h = makeHarness({
      runResult: { headSha: undefined, upsert: { action: "created", commentId: 5 }, findings: [] },
      deck: null,
    });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.out[0] as string);
    expect(parsed.headSha).toBeNull();
    expect(parsed.deck).toBeNull();
  });

  it("emits deck:null when the head resolved but the deck was not stored (deck build degraded)", async () => {
    // headSha present, but the store has no deck for it (the best-effort deck step
    // failed inside the seam). The output must not pretend a deck exists.
    const h = makeHarness({
      runResult: { headSha: "abc123", upsert: { action: "created", commentId: 9 }, findings: [] },
      deck: null,
    });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.out[0] as string);
    expect(parsed.headSha).toBe("abc123");
    expect(parsed.deck).toBeNull();
  });

  it("bad pr-ref → exit 2, diagnostic on stderr, no GitHub or DB work", async () => {
    const h = makeHarness();
    const code = await runReviewCommand(["not-a-ref"], h.deps, h.io);

    expect(code).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.err).toHaveLength(1);
    expect(h.createApp).not.toHaveBeenCalled();
    expect(h.openDb).not.toHaveBeenCalled();
  });

  it("--installation-id flag skips the getRepoInstallation lookup", async () => {
    const h = makeHarness();
    // The flag flows through loadConfig → cfg.installationId; emulate that here.
    h.deps.loadConfig = () => ({ ...cfg, installationId: 7 });
    const code = await runReviewCommand(
      ["octo-org/demo#42", "--installation-id", "7"],
      h.deps,
      h.io,
    );

    expect(code).toBe(0);
    expect(h.getRepoInstallation).not.toHaveBeenCalled();
  });

  it("GitHub lookup 404 → exit 4", async () => {
    const h = makeHarness({
      getRepoInstallationImpl: async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(4);
    expect(h.err).toHaveLength(1);
    expect(h.out).toEqual([]);
  });

  it("a 404 thrown deep in the pipeline (PR deleted mid-run) also → exit 4, db closed", async () => {
    const h = makeHarness({
      runImpl: async () => {
        throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
      },
    });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(4);
    expect(h.out).toEqual([]);
    // The handle opened before the failing run is still torn down.
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("an unexpected runtime error from the pipeline → exit 1, diagnostic on stderr, db closed", async () => {
    const h = makeHarness({
      runImpl: async () => {
        throw new Error("postgres connection reset");
      },
    });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toMatch(/postgres connection reset/);
    // Even on a runtime failure the db handle is released (finally block).
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("config error → exit 3", async () => {
    const h = makeHarness({
      loadConfig: () => {
        throw new CliConfigError("GITHUB_APP_ID is required");
      },
    });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(3);
    expect(h.out).toEqual([]);
  });

  it("a failing db close is reported to stderr but does not change a success exit code", async () => {
    const h = makeHarness({
      closeImpl: async () => {
        throw new Error("pool drain failed");
      },
    });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    // The review succeeded; the close failure is surfaced but non-fatal.
    expect(code).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(h.err.some((l) => /closing db/.test(l))).toBe(true);
  });
});
