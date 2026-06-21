// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardView } from "../../../../../../lib/codeWindow";
import { SwipeDeck } from "./SwipeDeck";

/**
 * End-to-end behavioural coverage for the swipe deck (issue #27). These exercise
 * the real component — the keyboard/click/touch affordances, the per-card decision
 * write, the progress indicator, the completion state, and the non-blocking motion
 * path — against the acceptance criteria, in jsdom. The pure gesture math lives in
 * `lib/codeWindow.test.ts`; this file is about the wiring those helpers feed.
 *
 * AC#1 swipeable cards · AC#2 highlighted code + risk + suggestions + explanation ·
 * AC#3 swipe advances and records a decision · AC#4 progress visible ·
 * AC#5 touch (pointer) + keyboard/click · AC#6 motion present but never blocking.
 */

function cardView(over: Partial<CardView> = {}): CardView {
  return {
    fingerprint: "fp-0",
    file: "src/auth.ts",
    tier: "High",
    riskScore: 4.2,
    suggestions: ["Token expiry uses < not <="],
    explanation: "Adds a session expiry guard.",
    code: [
      { number: 10, text: "if (now < expiry) {", highlighted: true },
      { number: 11, text: "  return session;", highlighted: false },
    ],
    removedLines: 0,
    highlightLabel: "Added lines 10–11",
    ...over,
  };
}

/** Stub `matchMedia` so the reduced-motion branch is deterministic per test. */
function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

/**
 * Dispatch a pointer event as a real `MouseEvent` (which carries `clientX` in
 * jsdom, unlike jsdom's stub `PointerEvent`) so the drag offset is observed. Each
 * dispatch is its own `act()` so the drag-offset state flushes between move and up,
 * matching how the browser delivers these in separate turns.
 */
function firePointer(node: Element, type: string, clientX: number) {
  const event = new MouseEvent(type, { clientX, bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: 1, configurable: true });
  act(() => {
    node.dispatchEvent(event);
  });
}

function renderDeck(cards: CardView[], recordSwipe = vi.fn(async () => {})) {
  render(
    <SwipeDeck cards={cards} owner="acme" repo="web" prNumber={7} recordSwipe={recordSwipe} />,
  );
  return recordSwipe;
}

beforeEach(() => {
  // Default to reduced motion so most tests advance synchronously (no timers).
  setReducedMotion(true);
  // jsdom does not implement pointer capture; the component calls it on drag start.
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = vi.fn();
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn();
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SwipeDeck — rendering (AC#1, AC#2, AC#4)", () => {
  it("renders the top card's tier, file, risk, explanation, suggestions, and highlighted code", () => {
    renderDeck([cardView()]);

    expect(screen.getByText("High")).toBeTruthy();
    expect(screen.getByText("src/auth.ts")).toBeTruthy();
    expect(screen.getByText("risk 4.2")).toBeTruthy();
    expect(screen.getByText("Adds a session expiry guard.")).toBeTruthy();
    expect(screen.getByText("Token expiry uses < not <=")).toBeTruthy();
    expect(screen.getByText("Added lines 10–11")).toBeTruthy();
    expect(screen.getByText("if (now < expiry) {")).toBeTruthy();
  });

  it("shows progress toward the whole deck being reviewed", () => {
    renderDeck([cardView({ fingerprint: "a" }), cardView({ fingerprint: "b" })]);
    expect(screen.getByText("0 / 2 reviewed")).toBeTruthy();
    const bar = screen.getByLabelText("Deck review progress") as HTMLProgressElement;
    expect(bar.value).toBe(0);
    expect(bar.max).toBe(2);
  });

  it("falls back to the highlight label when a card has no code window (AC#2 graceful)", () => {
    renderDeck([cardView({ code: null, removedLines: 3, highlightLabel: "Removed lines 4–6" })]);
    expect(screen.getByText("Removed lines 4–6")).toBeTruthy();
    expect(screen.getByText(/3 lines removed/)).toBeTruthy();
  });

  it("renders an empty-deck message when there are no cards", () => {
    renderDeck([]);
    expect(screen.getByText(/there is nothing to review/)).toBeTruthy();
  });
});

describe("SwipeDeck — keyboard affordance (AC#3, AC#5 desktop)", () => {
  it("records an 'up' decision and advances on ArrowRight", () => {
    const recordSwipe = renderDeck([
      cardView({ fingerprint: "a", file: "src/a.ts" }),
      cardView({ fingerprint: "b", file: "src/b.ts" }),
    ]);

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });

    expect(recordSwipe).toHaveBeenCalledTimes(1);
    const fd = recordSwipe.mock.calls[0][0] as FormData;
    expect(fd.get("sentiment")).toBe("up");
    expect(fd.get("fingerprint")).toBe("a");
    expect(fd.get("owner")).toBe("acme");
    expect(fd.get("prNumber")).toBe("7");
    // Advanced to the second card; progress reflects one reviewed.
    expect(screen.getByText("src/b.ts")).toBeTruthy();
    expect(screen.getByText("1 / 2 reviewed")).toBeTruthy();
  });

  it("records a 'down' decision on ArrowLeft", () => {
    const recordSwipe = renderDeck([cardView({ fingerprint: "a" })]);
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowLeft" });
    });
    const fd = recordSwipe.mock.calls[0][0] as FormData;
    expect(fd.get("sentiment")).toBe("down");
  });

  it("ignores auto-repeat so holding a key is a single decision", () => {
    const recordSwipe = renderDeck([
      cardView({ fingerprint: "a" }),
      cardView({ fingerprint: "b" }),
    ]);
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight", repeat: true });
    });
    expect(recordSwipe).not.toHaveBeenCalled();
    expect(screen.getByText("0 / 2 reviewed")).toBeTruthy();
  });

  it("ignores other keys", () => {
    const recordSwipe = renderDeck([cardView()]);
    act(() => {
      fireEvent.keyDown(window, { key: "Enter" });
      fireEvent.keyDown(window, { key: "a" });
    });
    expect(recordSwipe).not.toHaveBeenCalled();
  });
});

describe("SwipeDeck — button affordance (AC#5 desktop click)", () => {
  it("commits via the on-screen Looks good / Flag buttons", () => {
    const recordSwipe = renderDeck([
      cardView({ fingerprint: "a" }),
      cardView({ fingerprint: "b" }),
    ]);

    act(() => {
      fireEvent.click(screen.getByText(/Looks good/));
    });
    expect((recordSwipe.mock.calls[0][0] as FormData).get("sentiment")).toBe("up");

    act(() => {
      fireEvent.click(screen.getByText(/Flag/));
    });
    expect((recordSwipe.mock.calls[1][0] as FormData).get("sentiment")).toBe("down");
  });
});

describe("SwipeDeck — touch affordance (AC#5 mobile)", () => {
  it("commits a right swipe from a pointer drag past the threshold", () => {
    const recordSwipe = renderDeck([
      cardView({ fingerprint: "a", file: "src/a.ts" }),
      cardView({ fingerprint: "b", file: "src/b.ts" }),
    ]);
    const card = screen.getByTestId("swipe-card");

    firePointer(card, "pointerdown", 0);
    firePointer(card, "pointermove", 140);
    firePointer(card, "pointerup", 140);

    expect(recordSwipe).toHaveBeenCalledTimes(1);
    expect((recordSwipe.mock.calls[0][0] as FormData).get("sentiment")).toBe("up");
    expect(screen.getByText("src/b.ts")).toBeTruthy();
  });

  it("snaps back without committing when the drag is below the threshold", () => {
    const recordSwipe = renderDeck([cardView({ fingerprint: "a", file: "src/a.ts" })]);
    const card = screen.getByTestId("swipe-card");

    firePointer(card, "pointerdown", 0);
    firePointer(card, "pointermove", 20);
    firePointer(card, "pointerup", 20);

    expect(recordSwipe).not.toHaveBeenCalled();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });
});

describe("SwipeDeck — completion (AC#4)", () => {
  it("shows the completion summary after the last card, with the up/down tally", () => {
    renderDeck([cardView({ fingerprint: "a" })]);
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    expect(screen.getByText(/reviewed the whole deck/i)).toBeTruthy();
    expect(screen.getByText(/1 looked good/)).toBeTruthy();
    expect(screen.getByText(/0 flagged/)).toBeTruthy();
  });
});

describe("SwipeDeck — motion is present but never blocking (AC#6)", () => {
  it("fires the decision write immediately and advances only after the fly-off", () => {
    setReducedMotion(false);
    vi.useFakeTimers();
    const recordSwipe = renderDeck([
      cardView({ fingerprint: "a", file: "src/a.ts" }),
      cardView({ fingerprint: "b", file: "src/b.ts" }),
    ]);

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    // The write is not blocked by the animation — it has already fired.
    expect(recordSwipe).toHaveBeenCalledTimes(1);
    // The next card is not shown until the fly-off completes.
    expect(screen.queryByText("src/b.ts")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(screen.getByText("src/b.ts")).toBeTruthy();
  });

  it("guards against a double-commit during the fly-off: one decision, advance one card", () => {
    setReducedMotion(false);
    vi.useFakeTimers();
    const recordSwipe = renderDeck([
      cardView({ fingerprint: "a", file: "src/a.ts" }),
      cardView({ fingerprint: "b", file: "src/b.ts" }),
      cardView({ fingerprint: "c", file: "src/c.ts" }),
    ]);

    act(() => {
      // Two rapid presses inside the same animation window (key-mash / double-tap).
      fireEvent.keyDown(window, { key: "ArrowRight" });
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    // Exactly one reaction recorded despite two presses.
    expect(recordSwipe).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(260);
    });
    // Advanced exactly one card — the second card is shown, not the third.
    expect(screen.getByText("src/b.ts")).toBeTruthy();
    expect(screen.queryByText("src/c.ts")).toBeNull();
    expect(screen.getByText("1 / 3 reviewed")).toBeTruthy();
  });
});

describe("SwipeDeck — resilience", () => {
  it("does not crash the deck when the decision write rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const recordSwipe = vi.fn(async () => {
      throw new Error("network down");
    });
    renderDeck(
      [cardView({ fingerprint: "a" }), cardView({ fingerprint: "b", file: "src/b.ts" })],
      recordSwipe,
    );

    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });

    // The deck still advances; the rejection is logged, not thrown.
    expect(screen.getByText("src/b.ts")).toBeTruthy();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
