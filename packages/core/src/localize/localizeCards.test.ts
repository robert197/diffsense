import { describe, expect, it, vi } from "vitest";
import type { LocalizationStore } from "../ports/localizationStore.js";
import type { Card } from "../schemas/card.js";
import type { LocalizedCard } from "../schemas/localization.js";
import { LOCALIZE_CONCURRENCY, type LocalizePorts, localizeCards } from "./localizeCards.js";

function card(overrides: Partial<Card> = {}): Card {
  return {
    fingerprint: "fp-1",
    file: "src/auth.ts",
    tier: "High",
    rank: 0,
    riskScore: 4.2,
    highlights: [{ side: "R", start: 12, end: 18 }],
    suggestions: ["Null is dereferenced when the user is signed out."],
    explanation: "Adds a null-unsafe read of user.id.",
    ...overrides,
  };
}

const REF = { owner: "acme", repo: "web" };

function spyPorts(
  store: Partial<LocalizationStore> = {},
  localizeCard = vi.fn(),
): { ports: LocalizePorts; get: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> } {
  const get = (store.get as ReturnType<typeof vi.fn>) ?? vi.fn(async () => null);
  const save = (store.save as ReturnType<typeof vi.fn>) ?? vi.fn(async () => {});
  return { ports: { llm: { localizeCard }, store: { get, save } }, get, save };
}

describe("localizeCards — English passthrough", () => {
  it("returns the cards unchanged and never touches the ports", async () => {
    const cards = [card(), card({ fingerprint: "fp-2" })];
    const localizeCard = vi.fn();
    const { ports, get, save } = spyPorts({}, localizeCard);

    const result = await localizeCards(cards, "en", REF, ports);

    expect(result).toEqual(cards);
    expect(localizeCard).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("localizeCards — cache hit", () => {
  it("reuses the cached prose and never calls the provider", async () => {
    const cached: LocalizedCard = {
      explanation: "Añade una lectura no segura de user.id.",
      suggestions: ["Se desreferencia null cuando el usuario no ha iniciado sesión."],
    };
    const localizeCard = vi.fn();
    const { ports, save } = spyPorts({ get: vi.fn(async () => cached) }, localizeCard);

    const [out] = await localizeCards([card()], "es", REF, ports);

    expect(out?.explanation).toBe(cached.explanation);
    expect(out?.suggestions).toEqual(cached.suggestions);
    expect(localizeCard).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    // Non-prose fields untouched.
    expect(out?.fingerprint).toBe("fp-1");
    expect(out?.riskScore).toBe(4.2);
    expect(out?.highlights).toEqual([{ side: "R", start: 12, end: 18 }]);
  });
});

describe("localizeCards — cache miss → provider", () => {
  it("translates via the provider and writes the result to the cache", async () => {
    const translated: LocalizedCard = {
      explanation: "Fügt einen null-unsicheren Zugriff auf user.id hinzu.",
      suggestions: ["Null wird dereferenziert, wenn der Benutzer abgemeldet ist."],
    };
    const localizeCard = vi.fn(async () => translated);
    const { ports, get, save } = spyPorts({}, localizeCard);

    const [out] = await localizeCards([card()], "de", REF, ports);

    expect(out?.explanation).toBe(translated.explanation);
    expect(out?.suggestions).toEqual(translated.suggestions);
    expect(get).toHaveBeenCalledWith({
      owner: "acme",
      repo: "web",
      fingerprint: "fp-1",
      language: "de",
    });
    expect(localizeCard).toHaveBeenCalledWith({
      explanation: "Adds a null-unsafe read of user.id.",
      suggestions: ["Null is dereferenced when the user is signed out."],
      language: "de",
    });
    expect(save).toHaveBeenCalledWith(
      { owner: "acme", repo: "web", fingerprint: "fp-1", language: "de" },
      translated,
    );
  });
});

describe("localizeCards — fallbacks", () => {
  it("falls back to the English card when the provider throws", async () => {
    const original = card();
    const localizeCard = vi.fn().mockRejectedValue(new Error("provider down"));
    const { ports } = spyPorts({}, localizeCard);

    const [out] = await localizeCards([original], "fr", REF, ports);

    expect(out).toEqual(original);
  });

  it("falls back when the cache read throws", async () => {
    const original = card();
    const localizeCard = vi.fn();
    const { ports } = spyPorts(
      { get: vi.fn().mockRejectedValue(new Error("db down")) },
      localizeCard,
    );

    const [out] = await localizeCards([original], "fr", REF, ports);

    expect(out).toEqual(original);
    // The cache read failing short-circuits to English; the provider is not retried.
    expect(localizeCard).not.toHaveBeenCalled();
  });

  it("still returns the localized card when the cache save fails", async () => {
    const translated: LocalizedCard = { explanation: "traduit", suggestions: [] };
    const localizeCard = vi.fn(async () => translated);
    const { ports } = spyPorts(
      { save: vi.fn().mockRejectedValue(new Error("save failed")) },
      localizeCard,
    );

    const [out] = await localizeCards([card({ suggestions: [] })], "fr", REF, ports);

    expect(out?.explanation).toBe("traduit");
  });
});

describe("localizeCards — per-card isolation + immutability", () => {
  it("localizes independently in order; a mid-deck failure leaves only that card English", async () => {
    const cards = [
      card({ fingerprint: "a", explanation: "first" }),
      card({ fingerprint: "b", explanation: "second" }),
      card({ fingerprint: "c", explanation: "third" }),
    ];
    // Source cards carry one suggestion each; the provider must return one too, or
    // the card degrades to English (the count guard). The mock honours that count.
    const localizeCard = vi.fn(async ({ explanation }: { explanation: string }) => {
      if (explanation === "second") {
        throw new Error("boom");
      }
      return { explanation: `${explanation}-xx`, suggestions: ["sugerencia"] };
    });
    const { ports } = spyPorts({}, localizeCard);

    const out = await localizeCards(cards, "ja", REF, ports);

    expect(out.map((c) => c.explanation)).toEqual(["first-xx", "second", "third-xx"]);
    expect(out.map((c) => c.fingerprint)).toEqual(["a", "b", "c"]);
  });

  it("falls back to English when the localized suggestion count differs from the source", async () => {
    // The suggestions render as a position-stable list of "what could be wrong"
    // prompts, so a provider that drops/adds/merges items cannot be paired 1:1.
    // Rather than silently lose a risk prompt, the card degrades to English — and
    // the bad translation is never cached.
    const localizeCard = vi.fn(async () => ({
      explanation: "traducido",
      suggestions: ["una", "dos", "tres"],
    }));
    const { ports, save } = spyPorts({}, localizeCard);
    const original = card({ suggestions: ["only one"] });

    const [out] = await localizeCards([original], "es", REF, ports);

    expect(out).toEqual(original);
    expect(out?.explanation).toBe("Adds a null-unsafe read of user.id.");
    expect(save).not.toHaveBeenCalled();
  });

  it("falls back to English when a cached translation's suggestion count drifted", async () => {
    // A row cached before the count guard (or for stale source prompts) is rejected
    // on read for the same reason — never rendered as a mismatched list.
    const cached: LocalizedCard = { explanation: "stale", suggestions: ["a", "b"] };
    const localizeCard = vi.fn();
    const { ports } = spyPorts({ get: vi.fn(async () => cached) }, localizeCard);
    const original = card({ suggestions: ["only one"] });

    const [out] = await localizeCards([original], "es", REF, ports);

    expect(out).toEqual(original);
    expect(localizeCard).not.toHaveBeenCalled();
  });

  it("never alters non-prose fields (code/identifiers/risk preserved)", async () => {
    const original = card();
    const localizeCard = vi.fn(async () => ({ explanation: "x", suggestions: ["y"] }));
    const { ports } = spyPorts({}, localizeCard);

    const [out] = await localizeCards([original], "zh", REF, ports);

    expect(out?.fingerprint).toBe(original.fingerprint);
    expect(out?.file).toBe(original.file);
    expect(out?.tier).toBe(original.tier);
    expect(out?.rank).toBe(original.rank);
    expect(out?.riskScore).toBe(original.riskScore);
    expect(out?.highlights).toEqual(original.highlights);
  });
});

describe("localizeCards — bounded concurrency", () => {
  function manyCards(n: number): Card[] {
    return Array.from({ length: n }, (_, i) =>
      card({ fingerprint: `fp-${i}`, explanation: `e${i}` }),
    );
  }

  /** A provider mock that records the peak number of calls in flight at once. */
  function trackingProvider() {
    const state = { inFlight: 0, peak: 0 };
    const localizeCard = vi.fn(async ({ explanation }: { explanation: string }) => {
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      state.inFlight--;
      return { explanation: `${explanation}-x`, suggestions: ["s"] };
    });
    return { state, localizeCard };
  }

  it("keeps at most `concurrency` provider calls in flight and preserves order", async () => {
    const cards = manyCards(20);
    const { state, localizeCard } = trackingProvider();
    const { ports } = spyPorts({}, localizeCard);

    const out = await localizeCards(cards, "es", REF, ports, 4);

    expect(state.peak).toBeLessThanOrEqual(4);
    expect(state.peak).toBeGreaterThan(1); // actually ran concurrently, not serially
    expect(localizeCard).toHaveBeenCalledTimes(20);
    // Result order matches input order despite out-of-order completion.
    expect(out.map((c) => c.explanation)).toEqual(cards.map((c) => `${c.explanation}-x`));
    expect(out.map((c) => c.fingerprint)).toEqual(cards.map((c) => c.fingerprint));
  });

  it("defaults to LOCALIZE_CONCURRENCY when no limit is given", async () => {
    const cards = manyCards(30);
    const { state, localizeCard } = trackingProvider();
    const { ports } = spyPorts({}, localizeCard);

    await localizeCards(cards, "es", REF, ports);

    expect(state.peak).toBeLessThanOrEqual(LOCALIZE_CONCURRENCY);
    expect(state.peak).toBeGreaterThan(1);
  });
});
