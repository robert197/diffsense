import { beforeEach, describe, expect, it, vi } from "vitest";

// The action delegates the DB write to lib/deck; mock it to capture the call.
const h = vi.hoisted(() => ({
  calls: [] as unknown[][],
  // The action gates on getSession; default to a signed-in reviewer, override per test.
  session: { current: { login: "octocat" } as unknown },
  // setLanguage writes a cookie and revalidates the deck route; capture both.
  cookieSets: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
  revalidated: [] as string[],
}));
vi.mock("../../../../../../lib/deck", () => ({
  recordSwipe: (...args: unknown[]) => {
    h.calls.push(args);
    return Promise.resolve();
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

import { recordSwipe, setLanguage } from "./actions";

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
  fingerprint: "fp",
  tier: "High",
  sentiment: "up",
};

describe("recordSwipe action", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.session.current = { login: "octocat" };
  });

  it("persists a valid swipe with the parsed ref", async () => {
    await recordSwipe(form(valid));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual([{ owner: "acme", repo: "web", prNumber: 7 }, "fp", "High", "up"]);
  });

  it("drops the write when there is no authenticated session", async () => {
    h.session.current = null;
    await recordSwipe(form(valid));
    expect(h.calls).toHaveLength(0);
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
