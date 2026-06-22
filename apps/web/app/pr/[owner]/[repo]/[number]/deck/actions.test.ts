import { beforeEach, describe, expect, it, vi } from "vitest";

// The action delegates the DB write to lib/deck; mock it to capture the call.
const h = vi.hoisted(() => ({
  calls: [] as unknown[][],
  // The per-reviewer resume write (issue #29) delegates to lib/reviewProgress.
  progressCalls: [] as unknown[][],
  // When set, the resume write rejects — exercises the fire-and-forget catch.
  progressReject: null as Error | null,
  // When set, the reaction write rejects — exercises lib/deck's own catch.
  reactionReject: null as Error | null,
  // The action gates on getSession; default to a signed-in reviewer, override per test.
  session: { current: { userId: 42, login: "octocat" } as unknown },
  // setLanguage writes a cookie and revalidates the deck route; capture both.
  cookieSets: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
  revalidated: [] as string[],
  // postCardComment (issue #30): the latest deck it reads, the gateway post, the persist.
  deck: null as unknown,
  deckReject: null as Error | null,
  postCalls: [] as unknown[][],
  postResult: {
    id: 101,
    htmlUrl: "https://github.com/acme/web/pull/7#c101",
    kind: "review",
  } as unknown,
  postReject: null as Error | null,
  postedCalls: [] as unknown[][],
  postedReject: null as Error | null,
}));
vi.mock("../../../../../../lib/deck", () => ({
  recordSwipe: (...args: unknown[]) => {
    h.calls.push(args);
    return h.reactionReject ? Promise.reject(h.reactionReject) : Promise.resolve();
  },
  getLatestDeck: () => (h.deckReject ? Promise.reject(h.deckReject) : Promise.resolve(h.deck)),
}));
vi.mock("../../../../../../lib/prComments", () => ({
  recordPostedComment: (...args: unknown[]) => {
    h.postedCalls.push(args);
    return h.postedReject ? Promise.reject(h.postedReject) : Promise.resolve();
  },
}));
vi.mock("../../../../../../lib/reviewProgress", () => ({
  recordDecision: (...args: unknown[]) => {
    h.progressCalls.push(args);
    return h.progressReject ? Promise.reject(h.progressReject) : Promise.resolve();
  },
}));
vi.mock("../../../../../../lib/auth/session", () => ({
  getSession: () => Promise.resolve(h.session.current),
}));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      set: (name: string, value: string, options: Record<string, unknown>) => {
        h.cookieSets.push({ name, value, options });
      },
    }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    h.revalidated.push(path);
  },
}));

import type { Card, Deck } from "@diffsense/core";
import {
  GitHubAuthError,
  GitHubPermissionError,
  GitHubRateLimitError,
} from "../../../../../../lib/github";
import { postCardComment, recordSwipe, setLanguage } from "./actions";

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    f.set(k, v);
  }
  return f;
}

const valid = {
  owner: "acme",
  repo: "web",
  prNumber: "7",
  headSha: "h1",
  fingerprint: "fp",
  tier: "High",
  sentiment: "up",
};

describe("recordSwipe action", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.progressCalls.length = 0;
    h.progressReject = null;
    h.reactionReject = null;
    h.session.current = { userId: 42, login: "octocat" };
  });

  it("persists a valid swipe with the parsed ref", async () => {
    await recordSwipe(form(valid));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual([{ owner: "acme", repo: "web", prNumber: 7 }, "fp", "High", "up"]);
  });

  it("records a per-reviewer decision keyed by user + PR + head SHA (issue #29)", async () => {
    await recordSwipe(form(valid));
    expect(h.progressCalls).toHaveLength(1);
    expect(h.progressCalls[0]).toEqual([
      { githubUserId: 42, owner: "acme", repo: "web", prNumber: 7, headSha: "h1" },
      "fp",
      "up",
    ]);
  });

  it("forwards a down (flag) swipe to both the reaction and the resume write", async () => {
    await recordSwipe(form({ ...valid, sentiment: "down" }));
    expect(h.calls[0]).toEqual([{ owner: "acme", repo: "web", prNumber: 7 }, "fp", "High", "down"]);
    expect(h.progressCalls[0]).toEqual([
      { githubUserId: 42, owner: "acme", repo: "web", prNumber: 7, headSha: "h1" },
      "fp",
      "down",
    ]);
  });

  it("stays non-throwing when the resume write rejects (fire-and-forget), reaction still recorded", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.progressReject = new Error("db down");
    // The action must resolve, not reject — the swipe is fired fire-and-forget.
    await expect(recordSwipe(form(valid))).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(1); // reaction write happened first and stuck
    expect(h.progressCalls).toHaveLength(1); // resume write attempted, swallowed
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still attempts the resume write when the reaction write rejects", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.reactionReject = new Error("reaction insert failed");
    await expect(recordSwipe(form(valid))).resolves.toBeUndefined();
    // A failed reaction write is logged but must not suppress the resume row.
    expect(h.progressCalls).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("skips the resume write when headSha is absent but still records the reaction", async () => {
    const f = form(valid);
    f.delete("headSha");
    await recordSwipe(f);
    expect(h.calls).toHaveLength(1); // reaction still recorded (backward-safe)
    expect(h.progressCalls).toHaveLength(0); // no head SHA → no resume row
  });

  it("drops the write when there is no authenticated session", async () => {
    h.session.current = null;
    await recordSwipe(form(valid));
    expect(h.calls).toHaveLength(0);
    expect(h.progressCalls).toHaveLength(0);
  });

  it("rejects a missing owner", async () => {
    const f = form(valid);
    f.delete("owner");
    await recordSwipe(f);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a missing repo", async () => {
    const f = form(valid);
    f.delete("repo");
    await recordSwipe(f);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a non-positive prNumber", async () => {
    await recordSwipe(form({ ...valid, prNumber: "0" }));
    expect(h.calls).toHaveLength(0);
  });

  it("rejects an out-of-enum tier", async () => {
    await recordSwipe(form({ ...valid, tier: "Critical" }));
    expect(h.calls).toHaveLength(0);
  });

  it("rejects an out-of-enum sentiment", async () => {
    await recordSwipe(form({ ...valid, sentiment: "meh" }));
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a missing fingerprint", async () => {
    const f = form(valid);
    f.delete("fingerprint");
    await recordSwipe(f);
    expect(h.calls).toHaveLength(0);
  });
});

describe("setLanguage action", () => {
  const validLang = { owner: "acme", repo: "web", prNumber: "7", lang: "es" };

  beforeEach(() => {
    h.cookieSets.length = 0;
    h.revalidated.length = 0;
    h.session.current = { login: "octocat" };
  });

  it("sets the df_lang cookie and revalidates the deck route on a valid choice", async () => {
    await setLanguage(form(validLang));

    expect(h.cookieSets).toHaveLength(1);
    const set = h.cookieSets[0];
    expect(set?.name).toBe("df_lang");
    expect(set?.value).toBe("es");
    // Hardened cookie attributes — httpOnly + lax + Secure-in-prod, like the session cookie.
    expect(set?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(set?.options).toHaveProperty("secure");
    expect(set?.options).toHaveProperty("maxAge");
    expect(h.revalidated).toEqual(["/pr/acme/web/7/deck"]);
  });

  it("drops the write when there is no authenticated session", async () => {
    h.session.current = null;
    await setLanguage(form(validLang));
    expect(h.cookieSets).toHaveLength(0);
    expect(h.revalidated).toHaveLength(0);
  });

  it("drops an unsupported language without setting a cookie", async () => {
    await setLanguage(form({ ...validLang, lang: "klingon" }));
    expect(h.cookieSets).toHaveLength(0);
    expect(h.revalidated).toHaveLength(0);
  });

  it("drops an empty language value", async () => {
    await setLanguage(form({ ...validLang, lang: "" }));
    expect(h.cookieSets).toHaveLength(0);
    expect(h.revalidated).toHaveLength(0);
  });

  it("sets the cookie but skips revalidation when nav params are absent", async () => {
    await setLanguage(form({ lang: "fr" }));
    expect(h.cookieSets).toHaveLength(1);
    expect(h.cookieSets[0]?.value).toBe("fr");
    expect(h.revalidated).toHaveLength(0);
  });
});

describe("postCardComment action (issue #30)", () => {
  function card(over: Partial<Card> = {}): Card {
    return {
      fingerprint: "fp-a",
      file: "src/a.ts",
      tier: "High",
      rank: 0,
      riskScore: 1,
      highlights: [{ side: "R", start: 12, end: 18 }],
      suggestions: [],
      explanation: "adds a guard",
      ...over,
    };
  }
  function deck(cards: Card[] = [card()]): Deck {
    return { owner: "acme", repo: "web", prNumber: 7, headSha: "h1", cards };
  }
  const valid = {
    owner: "acme",
    repo: "web",
    prNumber: "7",
    fingerprint: "fp-a",
    body: "Looks off.",
  };

  // A signed-in reviewer whose OAuth client posts through the GitHubGateway port.
  function signedIn() {
    h.session.current = {
      userId: 42,
      login: "octocat",
      github: {
        postComment: (...args: unknown[]) => {
          h.postCalls.push(args);
          return h.postReject ? Promise.reject(h.postReject) : Promise.resolve(h.postResult);
        },
      },
    };
  }

  beforeEach(() => {
    h.postCalls.length = 0;
    h.postedCalls.length = 0;
    h.revalidated.length = 0;
    h.deck = deck();
    h.deckReject = null;
    h.postReject = null;
    h.postedReject = null;
    h.postResult = { id: 101, htmlUrl: "https://github.com/acme/web/pull/7#c101", kind: "review" };
    signedIn();
  });

  it("posts an anchored comment, persists it, and returns the link (happy path)", async () => {
    const res = await postCardComment({ ok: false }, form(valid));

    expect(res.ok).toBe(true);
    expect(res.comment).toEqual({
      htmlUrl: "https://github.com/acme/web/pull/7#c101",
      kind: "review",
    });
    // The gateway was called with the anchor derived from the card's right-side highlight.
    expect(h.postCalls).toHaveLength(1);
    const [ref, input] = h.postCalls[0] as [unknown, { body: string; anchor?: unknown }];
    expect(ref).toEqual({ owner: "acme", repo: "web", prNumber: 7 });
    expect(input.body).toBe("Looks off.");
    expect(input.anchor).toEqual({
      file: "src/a.ts",
      line: 18,
      startLine: 12,
      side: "RIGHT",
      commitId: "h1",
    });
    // It was recorded for reflection, keyed by reviewer + deck head.
    expect(h.postedCalls).toHaveLength(1);
    const [cref, entry] = h.postedCalls[0] as [unknown, { githubCommentId: number; kind: string }];
    expect(cref).toEqual({
      githubUserId: 42,
      owner: "acme",
      repo: "web",
      prNumber: 7,
      headSha: "h1",
    });
    expect(entry.githubCommentId).toBe(101);
    // No server-driven refresh: the composer shows the link inline (like recordSwipe,
    // which also never revalidates so a refresh can't fight the client deck state).
    expect(h.revalidated).not.toContain("/pr/acme/web/7/deck");
  });

  it("posts an unanchored conversation comment for a deletion-only card", async () => {
    h.deck = deck([card({ highlights: [{ side: "L", start: 4, end: 6 }] })]);
    h.postResult = { id: 202, htmlUrl: "https://github.com/acme/web/pull/7#i202", kind: "issue" };

    const res = await postCardComment({ ok: false }, form(valid));

    expect(res.ok).toBe(true);
    const [, input] = h.postCalls[0] as [unknown, { anchor?: unknown }];
    expect(input.anchor).toBeUndefined();
  });

  it("returns an error and never posts when there is no session", async () => {
    h.session.current = null;
    const res = await postCardComment({ ok: false }, form(valid));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/sign in/i);
    expect(h.postCalls).toHaveLength(0);
  });

  it("rejects an empty/whitespace body without posting", async () => {
    const res = await postCardComment({ ok: false }, form({ ...valid, body: "   " }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/write a comment/i);
    expect(h.postCalls).toHaveLength(0);
  });

  it("errors when the fingerprint matches no card in the current deck", async () => {
    const res = await postCardComment({ ok: false }, form({ ...valid, fingerprint: "missing" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no longer part/i);
    expect(h.postCalls).toHaveLength(0);
  });

  it("surfaces a permission denial clearly", async () => {
    h.postReject = new GitHubPermissionError();
    const res = await postCardComment({ ok: false }, form(valid));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission/i);
    expect(h.postedCalls).toHaveLength(0);
  });

  it("surfaces a rate limit clearly", async () => {
    h.postReject = new GitHubRateLimitError();
    const res = await postCardComment({ ok: false }, form(valid));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/rate limit/i);
  });

  it("surfaces an expired session clearly", async () => {
    h.postReject = new GitHubAuthError();
    const res = await postCardComment({ ok: false }, form(valid));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/session expired/i);
  });

  it("still reports success when persistence fails after a successful post", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.postedReject = new Error("db down");
    const res = await postCardComment({ ok: false }, form(valid));
    // The comment is already on GitHub — a record failure must not look like a post failure.
    expect(res.ok).toBe(true);
    expect(res.comment?.htmlUrl).toBe("https://github.com/acme/web/pull/7#c101");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
