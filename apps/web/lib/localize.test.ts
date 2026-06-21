import type { Card, LocalizationKey, LocalizePorts, LocalizedCard } from "@diffsense/core";
import { describe, expect, it, vi } from "vitest";
import { localizeDeckCards } from "./localize";

/**
 * Unit tests for the deck localization wrapper. The English-passthrough and
 * top-level-fallback behaviour is what `apps/web` adds on top of the core
 * orchestration (which is tested exhaustively in `@diffsense/core`); here we prove
 * the wrapper degrades gracefully and stays out of the ports on the English path.
 */

function card(overrides: Partial<Card> = {}): Card {
  return {
    fingerprint: "fp-1",
    file: "src/auth.ts",
    tier: "High",
    rank: 0,
    riskScore: 4.2,
    highlights: [{ side: "R", start: 12, end: 18 }],
    suggestions: ["Null is dereferenced when signed out."],
    explanation: "Adds a null-unsafe read of user.id.",
    ...overrides,
  };
}

const REF = { owner: "acme", repo: "web" };

describe("localizeDeckCards", () => {
  it("returns the cards unchanged for English without touching the ports", async () => {
    const cards = [card()];
    const ports: LocalizePorts = {
      llm: { localizeCard: vi.fn() },
      store: { get: vi.fn(), save: vi.fn() },
    };

    const result = await localizeDeckCards(cards, "en", REF, ports);

    expect(result).toEqual(cards);
    expect(ports.llm.localizeCard).not.toHaveBeenCalled();
    expect(ports.store.get).not.toHaveBeenCalled();
  });

  it("localizes via the injected ports for a non-English language", async () => {
    const ports: LocalizePorts = {
      llm: {
        localizeCard: vi.fn(async () => ({
          explanation: "Añade una lectura no segura de user.id.",
          suggestions: ["Se desreferencia null cuando se cierra sesión."],
        })),
      },
      store: { get: vi.fn(async () => null), save: vi.fn(async () => {}) },
    };

    const [out] = await localizeDeckCards([card()], "es", REF, ports);

    expect(out?.explanation).toBe("Añade una lectura no segura de user.id.");
    expect(out?.suggestions).toEqual(["Se desreferencia null cuando se cierra sesión."]);
    expect(out?.fingerprint).toBe("fp-1");
    expect(out?.riskScore).toBe(4.2);
    expect(ports.store.save).toHaveBeenCalled();
  });

  it("degrades each card to English when its store + provider both fail (per-card fallback)", async () => {
    // A ports object whose store + provider both blow up simulates the DB/provider
    // being unavailable; the core per-card fallback returns each English card, so the
    // wrapper still renders the English deck.
    const ports: LocalizePorts = {
      llm: {
        localizeCard: vi.fn().mockRejectedValue(new Error("provider down")),
      },
      store: {
        get: vi.fn().mockRejectedValue(new Error("db down")),
        save: vi.fn(),
      },
    };
    const cards = [card(), card({ fingerprint: "fp-2" })];

    const result = await localizeDeckCards(cards, "fr", REF, ports);

    expect(result).toEqual(cards);
  });

  it("degrades the whole deck to English when the provider cannot be constructed (top-level catch)", async () => {
    // With no ports injected, defaultLocalizePorts() builds the real provider from
    // env. An unsupported LLM_PROVIDER makes createReviewProvider throw synchronously
    // — the top-level try/catch in localizeDeckCards must swallow it and serve the
    // English deck rather than surface the error to the server render.
    vi.stubEnv("LLM_PROVIDER", "definitely-not-a-provider");
    try {
      const cards = [card(), card({ fingerprint: "fp-2" })];
      const result = await localizeDeckCards(cards, "es", REF);
      expect(result).toEqual(cards);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("re-opening a deck reuses the cache and spends no further inference (AC: cached per card/language)", async () => {
    // The core promise: a translated card is cached, so re-opening the same deck in
    // the same language calls the provider zero times. Uses a stateful in-memory
    // store (the real LocalizationStore interface), not a one-shot stub.
    const cache = new Map<string, LocalizedCard>();
    const keyOf = (k: LocalizationKey) => `${k.owner}/${k.repo}/${k.fingerprint}/${k.language}`;
    const localizeCard = vi.fn(
      async ({
        explanation,
        suggestions,
      }: { explanation: string; suggestions: readonly string[] }) => ({
        explanation: `${explanation} [es]`,
        suggestions: suggestions.map((s) => `${s} [es]`),
      }),
    );
    const ports: LocalizePorts = {
      llm: { localizeCard },
      store: {
        get: async (k) => cache.get(keyOf(k)) ?? null,
        save: async (k, value) => {
          cache.set(keyOf(k), value);
        },
      },
    };
    const cards = [
      card(),
      card({ fingerprint: "fp-2", explanation: "second", suggestions: ["s2"] }),
    ];

    const first = await localizeDeckCards(cards, "es", REF, ports);
    expect(localizeCard).toHaveBeenCalledTimes(2);
    expect(first[0]?.explanation).toBe("Adds a null-unsafe read of user.id. [es]");
    expect(first[1]?.explanation).toBe("second [es]");

    localizeCard.mockClear();

    const second = await localizeDeckCards(cards, "es", REF, ports);
    expect(localizeCard).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });
});
