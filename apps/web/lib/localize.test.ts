import type { Card, LocalizePorts } from "@diffsense/core";
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

  it("degrades the whole deck to English if localization throws at the top level", async () => {
    // A ports object whose store + provider both blow up simulates the DB/provider
    // being unavailable; the wrapper must still render the English deck.
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
});
