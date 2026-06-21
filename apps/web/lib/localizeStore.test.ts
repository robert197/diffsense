import type { LocalizationKey, LocalizedCard } from "@diffsense/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for `webLocalizationStore` — the Drizzle-backed `LocalizationStore`
 * that `apps/web` wires into the core orchestration. The core cache-first logic is
 * tested exhaustively in `@diffsense/core`; here we prove the web adapter's own
 * value-add: the re-validation guard on read (a malformed stored row degrades to a
 * miss, never broken prose to the deck) and the keyed upsert on write. The Drizzle
 * client and operators are mocked so the test needs no Postgres.
 */

const h = vi.hoisted(() => ({
  selectRows: [] as Array<{ localized: unknown }>,
  inserted: [] as Array<{ values: Record<string, unknown> }>,
}));

// localize.ts builds its WHERE with drizzle-orm's and()/eq(); stub them to inert
// markers so the query chain never needs a real schema column.
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
}));

vi.mock("./db", () => ({
  cardLocalizations: {
    owner: "owner",
    repo: "repo",
    fingerprint: "fingerprint",
    language: "language",
    localized: "localized",
  },
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(h.selectRows),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => {
          h.inserted.push({ values });
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

import { webLocalizationStore } from "./localize";

const KEY: LocalizationKey = { owner: "acme", repo: "web", fingerprint: "fp-1", language: "es" };

describe("webLocalizationStore.get", () => {
  beforeEach(() => {
    h.selectRows.length = 0;
    h.inserted.length = 0;
  });

  it("returns null on a cache miss (no row)", async () => {
    expect(await webLocalizationStore().get(KEY)).toBeNull();
  });

  it("returns the validated LocalizedCard on a hit", async () => {
    const stored: LocalizedCard = { explanation: "hola", suggestions: ["uno", "dos"] };
    h.selectRows.push({ localized: stored });
    expect(await webLocalizationStore().get(KEY)).toEqual(stored);
  });

  it("degrades a malformed stored row to null instead of feeding broken prose", async () => {
    h.selectRows.push({ localized: { explanation: "", suggestions: "not-an-array" } });
    expect(await webLocalizationStore().get(KEY)).toBeNull();
  });

  it("degrades a row missing the suggestions field to null", async () => {
    h.selectRows.push({ localized: { explanation: "hola" } });
    expect(await webLocalizationStore().get(KEY)).toBeNull();
  });
});

describe("webLocalizationStore.save", () => {
  beforeEach(() => {
    h.selectRows.length = 0;
    h.inserted.length = 0;
  });

  it("upserts the localized prose keyed by (owner, repo, fingerprint, language)", async () => {
    const value: LocalizedCard = { explanation: "hola", suggestions: ["uno"] };
    await webLocalizationStore().save(KEY, value);

    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]?.values).toMatchObject({
      owner: "acme",
      repo: "web",
      fingerprint: "fp-1",
      language: "es",
      localized: value,
    });
  });
});
