import type { Deck, DeckStore, FindingStore, ReviewFinding } from "@diffsense/core";
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
  runReviewForRef: ReturnType<typeof vi.fn>;
}

function makeHarness(
  over: {
    loadConfig?: ReviewCommandDeps["loadConfig"];
    getRepoInstallationImpl?: (p: { owner: string; repo: string }) => Promise<{
      data: { id: number };
    }>;
    deck?: Deck | null;
    findings?: ReviewFinding[];
    reviewSupport?: ReviewSupport | null;
    runResult?: RunReviewResult;
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
  const findingStore: FindingStore = {
    replaceForPr: vi.fn(async () => {}),
    listByPr: vi.fn(async () => over.findings ?? [finding]),
  };
  const close = vi.fn(async () => {});
  const openDb = vi.fn(() => ({ db: {} as Database, close }));
  const runReviewForRef = vi.fn(
    async (): Promise<RunReviewResult> =>
      over.runResult ?? { headSha: "abc123", upsert: { action: "created", commentId: 999 } },
  );

  const deps: ReviewCommandDeps = {
    env: {},
    loadConfig: over.loadConfig ?? (() => cfg),
    createApp,
    openDb,
    createDeckStore: () => deckStore,
    createFindingStore: () => findingStore,
    buildReviewSupport: () =>
      over.reviewSupport === undefined
        ? ({ makeRunner: vi.fn() } as ReviewSupport)
        : over.reviewSupport,
    runReviewForRef,
    newDeliveryId: () => "fixed-id",
  };

  return { deps, io, out, err, getRepoInstallation, createApp, openDb, runReviewForRef };
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
});

describe("runReviewCommand (#32 U5)", () => {
  it("happy path: emits exactly one JSON object with deck + findings, returns 0", async () => {
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
  });

  it("LLM-off: reports llm:false but still emits the deck, returns 0", async () => {
    const h = makeHarness({ reviewSupport: null });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.out[0] as string);
    expect(parsed.llm).toBe(false);
    expect(parsed.deck.cards).toHaveLength(2);
  });

  it("emits deck:null when the head SHA could not be resolved", async () => {
    const h = makeHarness({
      runResult: { headSha: undefined, upsert: { action: "created", commentId: 5 } },
      deck: null,
    });
    const code = await runReviewCommand(["octo-org/demo#42"], h.deps, h.io);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.out[0] as string);
    expect(parsed.headSha).toBeNull();
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
});
