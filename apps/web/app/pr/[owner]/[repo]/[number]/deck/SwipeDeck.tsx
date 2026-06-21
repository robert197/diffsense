"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import type { CardView, CodeLine } from "../../../../../../lib/codeWindow";
import { deckProgress, resolveSwipe, swipeSentiment } from "../../../../../../lib/codeWindow";

/**
 * The swipe deck (issue #27) — the heart of the product. Renders a PR's deck as a
 * stack of swipeable cards: drag (Pointer Events, touch + mouse) or arrow keys /
 * buttons advance the deck, each swipe records an advisory 👍/👎 decision, and a
 * progress bar tracks the goal — by the end every changed hunk has been seen, the
 * risky parts first. Motion is CSS-only and fired through `startTransition`, so the
 * decision write never blocks the next card (and reduced-motion users get no
 * fly-off at all). Strictly advisory: no merge/approve/block control anywhere.
 */

const TIER_COLOR: Record<string, string> = {
  High: "#f87171",
  Medium: "#fbbf24",
  Low: "#9ca3af",
};

const SWIPE_OUT_MS = 260;

type Direction = "right" | "left";

export interface SwipeDeckProps {
  cards: CardView[];
  owner: string;
  repo: string;
  prNumber: number;
  recordSwipe: (formData: FormData) => Promise<void>;
}

export function SwipeDeck({ cards, owner, repo, prNumber, recordSwipe }: SwipeDeckProps) {
  const [index, setIndex] = useState(0);
  const [counts, setCounts] = useState({ up: 0, down: 0 });
  const [dragX, setDragX] = useState(0);
  const [leaving, setLeaving] = useState<Direction | null>(null);
  const [, startWrite] = useTransition();

  const dragStart = useRef<number | null>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const total = cards.length;
  const current = index < total ? cards[index] : null;
  const progress = deckProgress(index, total);

  const reducedMotion = useCallback(() => {
    return (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    );
  }, []);

  const commit = useCallback(
    (direction: Direction) => {
      const card = cards[index];
      if (!card || leaving) {
        return;
      }
      const sentiment = swipeSentiment(direction);

      // Fire-and-forget — the decision write must never block the animation.
      const fd = new FormData();
      fd.set("owner", owner);
      fd.set("repo", repo);
      fd.set("prNumber", String(prNumber));
      fd.set("fingerprint", card.fingerprint);
      fd.set("tier", card.tier);
      fd.set("sentiment", sentiment);
      startWrite(() => {
        void recordSwipe(fd);
      });

      setCounts((c) => ({
        up: c.up + (sentiment === "up" ? 1 : 0),
        down: c.down + (sentiment === "down" ? 1 : 0),
      }));

      const advance = () => {
        setLeaving(null);
        setDragX(0);
        dragStart.current = null;
        setIndex((i) => i + 1);
      };

      if (reducedMotion()) {
        advance();
        return;
      }
      setLeaving(direction);
      advanceTimer.current = setTimeout(advance, SWIPE_OUT_MS);
    },
    [cards, index, leaving, owner, repo, prNumber, recordSwipe, reducedMotion],
  );

  // Desktop keyboard affordance: ← flags, → looks good.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") {
        commit("right");
      } else if (e.key === "ArrowLeft") {
        commit("left");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit]);

  useEffect(() => {
    return () => {
      if (advanceTimer.current) {
        clearTimeout(advanceTimer.current);
      }
    };
  }, []);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (leaving) {
      return;
    }
    dragStart.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragStart.current === null || leaving) {
      return;
    }
    setDragX(e.clientX - dragStart.current);
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragStart.current === null || leaving) {
      return;
    }
    const width = e.currentTarget.getBoundingClientRect().width || 320;
    const { committed, direction } = resolveSwipe(dragX, width);
    if (committed) {
      commit(direction);
    } else {
      // Snap back.
      setDragX(0);
      dragStart.current = null;
    }
  }

  if (total === 0) {
    return <p style={{ opacity: 0.6 }}>This deck has no cards — there is nothing to review.</p>;
  }

  if (!current) {
    return <DeckDone counts={counts} total={total} />;
  }

  // Translate + slight rotate while dragging; fly fully off-screen on commit.
  const offset = leaving ? (leaving === "right" ? 1 : -1) * 1000 : dragX;
  const topStyle: CSSProperties = {
    transform: `translateX(${offset}px) rotate(${offset / 28}deg)`,
    transition:
      dragStart.current !== null && !leaving ? "none" : `transform ${SWIPE_OUT_MS}ms ease`,
    opacity: leaving ? 0 : 1,
    touchAction: "pan-y",
  };

  const intent = dragX > 8 ? "good" : dragX < -8 ? "flag" : null;

  return (
    <div>
      <ProgressBar done={progress.done} total={progress.total} percent={progress.percent} />

      <div style={stackWrap}>
        {/* A peek of the next card to convey a deck behind the top one. */}
        {cards[index + 1] && <div style={peekStyle} aria-hidden="true" />}

        <div
          style={{ ...cardStyle, ...topStyle }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {intent && <IntentBadge intent={intent} />}
          <CardBody card={current} />
        </div>
      </div>

      <div style={controls}>
        <button type="button" style={flagButton} onClick={() => commit("left")}>
          ✕ Flag
        </button>
        <span style={{ opacity: 0.5, fontSize: "0.8rem" }}>← → or swipe</span>
        <button type="button" style={goodButton} onClick={() => commit("right")}>
          Looks good ✓
        </button>
      </div>
    </div>
  );
}

function CardBody({ card }: { card: CardView }) {
  return (
    <article>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.6rem" }}>
        <span style={{ ...tierChip, background: TIER_COLOR[card.tier] ?? "#9ca3af" }}>
          {card.tier}
        </span>
        <code style={{ fontSize: "0.8rem", opacity: 0.9, wordBreak: "break-all" }}>
          {card.file}
        </code>
        <span style={{ marginLeft: "auto", ...riskBadge }}>risk {card.riskScore.toFixed(1)}</span>
      </div>

      <CodeBlock card={card} />

      <p style={{ margin: "0.85rem 0 0", lineHeight: 1.5 }}>{card.explanation}</p>

      {card.suggestions.length > 0 && (
        <section style={{ marginTop: "0.85rem" }}>
          <h2 style={heading}>What could be wrong</h2>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.4rem" }}>
            {card.suggestions.map((s, i) => (
              <li key={`${card.fingerprint}-sug-${i}`} style={{ lineHeight: 1.45 }}>
                {s}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function CodeBlock({ card }: { card: CardView }) {
  if (card.code && card.code.length > 0) {
    return (
      <div>
        <h2 style={heading}>{card.highlightLabel}</h2>
        <pre style={codePre}>
          <code>
            {card.code.map((line) => (
              <CodeLineRow key={line.number} line={line} />
            ))}
          </code>
        </pre>
      </div>
    );
  }

  // No code window — show the highlight ranges descriptively (graceful fallback).
  return (
    <div style={fallbackBox}>
      <span style={{ fontSize: "0.78rem", opacity: 0.8 }}>{card.highlightLabel}</span>
      {card.removedLines > 0 && (
        <span style={{ fontSize: "0.78rem", opacity: 0.6, marginLeft: "0.5rem" }}>
          ({card.removedLines} line{card.removedLines === 1 ? "" : "s"} removed)
        </span>
      )}
    </div>
  );
}

function CodeLineRow({ line }: { line: CodeLine }) {
  return (
    <div
      style={{
        display: "flex",
        background: line.highlighted ? "rgba(251, 191, 36, 0.14)" : "transparent",
        borderLeft: line.highlighted ? "3px solid #fbbf24" : "3px solid transparent",
      }}
    >
      <span style={lineNo}>{line.number}</span>
      <span style={{ whiteSpace: "pre", overflowX: "auto" }}>{line.text || " "}</span>
    </div>
  );
}

function ProgressBar({ done, total, percent }: { done: number; total: number; percent: number }) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <div
        style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.35rem" }}
        aria-hidden="true"
      >
        <span style={{ fontSize: "0.78rem", opacity: 0.7 }}>
          {done} / {total} reviewed
        </span>
        <span style={{ fontSize: "0.78rem", opacity: 0.5 }}>{percent}%</span>
      </div>
      {/* Native progress carries the accessible semantics; the styled bar below is
          decorative so the dark theme renders consistently across browsers. */}
      <progress
        value={done}
        max={Math.max(total, 1)}
        aria-label="Deck review progress"
        style={srOnly}
      />
      <div style={progressTrack} aria-hidden="true">
        <div style={{ ...progressFill, width: `${percent}%` }} />
      </div>
    </div>
  );
}

function IntentBadge({ intent }: { intent: "good" | "flag" }) {
  const good = intent === "good";
  return (
    <span
      style={{
        position: "absolute",
        top: "0.8rem",
        ...(good ? { right: "0.8rem" } : { left: "0.8rem" }),
        fontSize: "0.72rem",
        fontWeight: 700,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        padding: "0.2rem 0.5rem",
        borderRadius: 6,
        border: `1px solid ${good ? "#34d399" : "#f87171"}`,
        color: good ? "#34d399" : "#f87171",
      }}
    >
      {good ? "Looks good" : "Flag"}
    </span>
  );
}

function DeckDone({ counts, total }: { counts: { up: number; down: number }; total: number }) {
  return (
    <div style={{ ...cardStatic, textAlign: "center" }}>
      <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.2rem" }}>You've reviewed the whole deck</h2>
      <p style={{ opacity: 0.7, lineHeight: 1.5, margin: "0 0 1rem" }}>
        Every one of the {total} changed {total === 1 ? "chunk" : "chunks"} has been seen, the
        riskiest first. This is advisory — your swipes are signal, not a verdict.
      </p>
      <p style={{ margin: 0 }}>
        <span style={{ color: "#34d399", fontWeight: 600 }}>{counts.up} looked good</span>
        {"  ·  "}
        <span style={{ color: "#f87171", fontWeight: 600 }}>{counts.down} flagged</span>
      </p>
    </div>
  );
}

const stackWrap: CSSProperties = {
  position: "relative",
  minHeight: 360,
};

const cardStyle: CSSProperties = {
  position: "relative",
  border: "1px solid #1f2933",
  borderRadius: 14,
  padding: "1.1rem 1.25rem",
  background: "#11151a",
  boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
  cursor: "grab",
  userSelect: "none",
  WebkitUserSelect: "none",
};

const cardStatic: CSSProperties = {
  border: "1px solid #1f2933",
  borderRadius: 14,
  padding: "1.5rem 1.25rem",
  background: "#11151a",
};

const peekStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  top: 10,
  transform: "scale(0.97)",
  border: "1px solid #1f2933",
  borderRadius: 14,
  background: "#0d1116",
  opacity: 0.6,
};

const controls: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.6rem",
  marginTop: "1.1rem",
};

const buttonBase: CSSProperties = {
  minHeight: 44,
  padding: "0.6rem 1rem",
  borderRadius: 10,
  fontWeight: 600,
  fontSize: "0.95rem",
  cursor: "pointer",
  background: "transparent",
};

const flagButton: CSSProperties = {
  ...buttonBase,
  border: "1px solid #f87171",
  color: "#f87171",
};

const goodButton: CSSProperties = {
  ...buttonBase,
  border: "1px solid #34d399",
  color: "#34d399",
};

const tierChip: CSSProperties = {
  fontSize: "0.7rem",
  fontWeight: 700,
  color: "#0b0d10",
  borderRadius: 999,
  padding: "0.1rem 0.55rem",
};

const riskBadge: CSSProperties = {
  fontSize: "0.7rem",
  opacity: 0.7,
  border: "1px solid #374151",
  borderRadius: 999,
  padding: "0.1rem 0.5rem",
  whiteSpace: "nowrap",
};

const heading: CSSProperties = {
  fontSize: "0.7rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  opacity: 0.55,
  margin: "0 0 0.35rem",
};

const codePre: CSSProperties = {
  margin: 0,
  padding: "0.6rem 0",
  background: "#0b0d10",
  border: "1px solid #1f2933",
  borderRadius: 8,
  fontSize: "0.78rem",
  lineHeight: 1.5,
  overflowX: "auto",
};

const lineNo: CSSProperties = {
  display: "inline-block",
  width: "2.6rem",
  paddingRight: "0.6rem",
  textAlign: "right",
  opacity: 0.4,
  userSelect: "none",
  flexShrink: 0,
};

const fallbackBox: CSSProperties = {
  padding: "0.7rem 0.8rem",
  background: "#0b0d10",
  border: "1px dashed #374151",
  borderRadius: 8,
};

const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const progressTrack: CSSProperties = {
  height: 6,
  borderRadius: 999,
  background: "#1f2933",
  overflow: "hidden",
};

const progressFill: CSSProperties = {
  height: "100%",
  background: "#2563eb",
  transition: "width 200ms ease",
};
