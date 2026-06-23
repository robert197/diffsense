"use client";

import {
  Check,
  CheckCircle2,
  ExternalLink,
  FileCode2,
  Lightbulb,
  MessageSquarePlus,
  Sparkles,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { RiskMeter, TierBadge } from "../../../../../../components/review/RiskIndicator";
import { Button } from "../../../../../../components/ui/button";
import { Kbd } from "../../../../../../components/ui/kbd";
import { Textarea } from "../../../../../../components/ui/textarea";
import { cn } from "../../../../../../lib/cn";
import type { CardView, CodeLine } from "../../../../../../lib/codeWindow";
import { deckProgress, resolveSwipe, swipeSentiment } from "../../../../../../lib/codeWindow";
import { normalizeTier } from "../../../../../../lib/ui";

/**
 * The swipe deck (issue #27) — the heart of the product. Renders a PR's deck as a
 * stack of swipeable cards: drag (Pointer Events, touch + mouse) or arrow keys /
 * buttons advance the deck, each swipe records an advisory 👍/👎 decision, and a
 * progress bar tracks the goal — by the end every changed hunk has been seen, the
 * risky parts first. Motion is CSS-only and fired through `startTransition`, so the
 * decision write never blocks the next card (and reduced-motion users get no
 * fly-off at all). Strictly advisory: no merge/approve/block control anywhere.
 */

const SWIPE_OUT_MS = 260;

type Direction = "right" | "left";

/** Whether the OS asks us to minimise motion. Read live so a mid-session toggle is honoured. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** A keydown landing in a form field elsewhere on the page must not drive the deck. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * The result of posting a PR comment from a card (issue #30), rendered by the
 * composer via `useActionState`. Structurally matches the `postCardComment` action's
 * return so the server action can be passed straight in as the `postComment` prop.
 */
export interface PostCommentResult {
  ok: boolean;
  error?: string;
  comment?: { htmlUrl: string; kind: "review" | "issue" };
}

export interface SwipeDeckProps {
  cards: CardView[];
  owner: string;
  repo: string;
  prNumber: number;
  /** PR head SHA this deck was built against — part of the resume key (#29). */
  headSha: string;
  /** Resume point: the index of the first unreviewed card (#29). Defaults to 0. */
  initialIndex?: number;
  /** Prior 👍/👎 tally from persisted decisions, so the progress reflects resumed work. */
  initialCounts?: { up: number; down: number };
  recordSwipe: (formData: FormData) => Promise<void>;
  /** Post a reviewer comment to the PR from a card (issue #30). */
  postComment: (prev: PostCommentResult, formData: FormData) => Promise<PostCommentResult>;
}

export function SwipeDeck({
  cards,
  owner,
  repo,
  prNumber,
  headSha,
  initialIndex = 0,
  initialCounts,
  recordSwipe,
  postComment,
}: SwipeDeckProps) {
  const [index, setIndex] = useState(initialIndex);
  const [counts, setCounts] = useState(initialCounts ?? { up: 0, down: 0 });
  const [dragX, setDragX] = useState(0);
  const [leaving, setLeaving] = useState<Direction | null>(null);
  const [, startWrite] = useTransition();

  const dragStart = useRef<number | null>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Synchronous re-entry guard. `leaving` is React state and reads stale within the
  // same tick, so a second commit (key auto-repeat, double-tap, button double-click)
  // could slip past a state-based guard and double-record + skip a card. A ref is
  // visible immediately; it is released in `advance`, once the card has moved on.
  const committing = useRef(false);

  const total = cards.length;
  const current = index < total ? cards[index] : null;
  const progress = deckProgress(index, total);

  // The deck's risk make-up — shown up front so the reviewer knows the lay of the
  // land (how many high-risk cards are coming) before they start swiping.
  const composition = useMemo(() => {
    const c = { High: 0, Medium: 0, Low: 0 };
    for (const card of cards) {
      c[normalizeTier(card.tier)] += 1;
    }
    return c;
  }, [cards]);

  const clearAdvanceTimer = useCallback(() => {
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  }, []);

  const commit = useCallback(
    (direction: Direction) => {
      const card = cards[index];
      if (!card || committing.current) {
        return;
      }
      committing.current = true;
      const sentiment = swipeSentiment(direction);

      const fd = new FormData();
      fd.set("owner", owner);
      fd.set("repo", repo);
      fd.set("prNumber", String(prNumber));
      fd.set("headSha", headSha);
      fd.set("fingerprint", card.fingerprint);
      fd.set("tier", card.tier);
      fd.set("sentiment", sentiment);
      // Fire-and-forget — the write must never block the animation — but a rejection
      // is logged rather than swallowed, so a lost advisory signal stays visible.
      startWrite(() => {
        recordSwipe(fd).catch((err) => {
          console.error("[deck] recordSwipe write failed", err);
        });
      });

      setCounts((c) => ({
        up: c.up + (sentiment === "up" ? 1 : 0),
        down: c.down + (sentiment === "down" ? 1 : 0),
      }));

      const advance = () => {
        clearAdvanceTimer();
        setLeaving(null);
        setDragX(0);
        dragStart.current = null;
        committing.current = false;
        setIndex((i) => i + 1);
      };

      // Cancel any timer still pending from a prior commit before scheduling, so
      // exactly one advance is ever in flight (covers a reduced-motion toggle
      // mid-animation and any overlap that slips the ref guard).
      clearAdvanceTimer();
      if (prefersReducedMotion()) {
        advance();
        return;
      }
      setLeaving(direction);
      advanceTimer.current = setTimeout(advance, SWIPE_OUT_MS);
    },
    [cards, index, owner, repo, prNumber, headSha, recordSwipe, clearAdvanceTimer],
  );

  // Desktop keyboard affordance: ← flags, → looks good. Auto-repeat (held key) and
  // keystrokes aimed at a form field elsewhere on the page are ignored.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.repeat || isTypingTarget(e.target)) {
        return;
      }
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

  // Capture ends here for every pointer outcome — pointerup, pointercancel, or the
  // OS stealing the pointer mid-gesture. Reset any in-progress drag (unless a commit
  // is animating) so an interrupted gesture snaps back and the next gesture never
  // reads a stale start point.
  function onLostPointerCapture() {
    if (!committing.current) {
      dragStart.current = null;
      setDragX(0);
    }
  }

  if (total === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center text-muted-foreground">
        This deck has no cards — there is nothing to review.
      </p>
    );
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
      <DeckSummary composition={composition} total={total} />
      <ProgressBar done={progress.done} total={progress.total} percent={progress.percent} />

      <div className="relative min-h-[22rem]">
        {/* A peek of the next card to convey a deck behind the top one. */}
        {cards[index + 1] && (
          <div
            aria-hidden
            className="absolute inset-x-2 top-3 h-full scale-[0.97] rounded-xl border border-border bg-card/40"
          />
        )}

        <div
          data-testid="swipe-card"
          style={topStyle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onLostPointerCapture}
          className="relative cursor-grab touch-pan-y select-none rounded-xl border border-border bg-card p-5 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.6)] active:cursor-grabbing"
        >
          {intent && <IntentStamp intent={intent} strength={Math.min(Math.abs(dragX) / 120, 1)} />}
          {/* Key per card so the composer's open/draft/result state resets on advance. */}
          <CardBody
            key={current.fingerprint}
            card={current}
            owner={owner}
            repo={repo}
            prNumber={prNumber}
            postComment={postComment}
          />
        </div>
      </div>

      <div className="mt-5 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <Button type="button" variant="danger" size="lg" onClick={() => commit("left")}>
          <X />
          Flag
        </Button>
        <div className="flex flex-col items-center gap-1 text-muted-foreground">
          <div className="flex items-center gap-1">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
          </div>
          <span className="text-[0.7rem]">or swipe</span>
        </div>
        <Button type="button" variant="success" size="lg" onClick={() => commit("right")}>
          Looks good
          <Check />
        </Button>
      </div>
    </div>
  );
}

/**
 * The deck's risk make-up at a glance: a single segmented bar (high → low) plus the
 * per-tier counts. Lets the reviewer size up the work before the first swipe — the
 * whole point of risk-ordering is knowing where the danger is concentrated.
 */
function DeckSummary({
  composition,
  total,
}: {
  composition: { High: number; Medium: number; Low: number };
  total: number;
}) {
  const segments = [
    { key: "High", count: composition.High, fill: "bg-tier-high", text: "text-tier-high" },
    { key: "Medium", count: composition.Medium, fill: "bg-tier-medium", text: "text-tier-medium" },
    { key: "Low", count: composition.Low, fill: "bg-tier-low", text: "text-tier-low" },
  ].filter((s) => s.count > 0);

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex items-center gap-3 text-xs">
        {segments.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", s.fill)} />
            <span className="tabular-nums text-foreground/80">{`${s.count} ${s.key}`}</span>
          </span>
        ))}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {total} {total === 1 ? "card" : "cards"}
      </span>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        {segments.map((s) => (
          <div
            key={s.key}
            className={cn("h-full", s.fill)}
            style={{ width: `${(s.count / total) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function CardBody({
  card,
  owner,
  repo,
  prNumber,
  postComment,
}: {
  card: CardView;
  owner: string;
  repo: string;
  prNumber: number;
  postComment: SwipeDeckProps["postComment"];
}) {
  return (
    <article>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <TierBadge tier={card.tier} className="self-start" />
          <code className="truncate text-sm text-foreground/90">{card.file}</code>
        </div>
        <RiskMeter tier={card.tier} score={card.riskScore} />
      </div>

      <div className="mt-4">
        <CodeBlock card={card} />
      </div>

      <div className="mt-4">
        <Eyebrow icon={<Sparkles className="size-3.5" />}>What this change does</Eyebrow>
        <p className="mt-1.5 leading-relaxed">{card.explanation}</p>
      </div>

      {card.suggestions.length > 0 && (
        <section className="mt-4">
          <Eyebrow icon={<Lightbulb className="size-3.5" />}>What could be wrong</Eyebrow>
          <ul className="mt-2 flex flex-col gap-1.5">
            {card.suggestions.map((s, i) => (
              <li
                key={`${card.fingerprint}-sug-${i}`}
                className="flex gap-2 rounded-lg border border-tier-medium/20 bg-tier-medium-fill/40 px-3 py-2 text-sm leading-relaxed"
              >
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-tier-medium" />
                {s}
              </li>
            ))}
          </ul>
        </section>
      )}

      <CommentComposer
        card={card}
        owner={owner}
        repo={repo}
        prNumber={prNumber}
        postComment={postComment}
      />
    </article>
  );
}

/**
 * Leave a comment on the PR straight from a card (issue #30). Reviewer-initiated and
 * low-noise: the composer is collapsed behind a button so the card stays clean, and
 * nothing posts until the reviewer clicks Post. Posting goes through the
 * `postComment` server action (the `GitHubGateway` port); the result is rendered via
 * `useActionState` — a link on success, a clear message on failure. Comments the
 * reviewer already posted from this card are reflected above the composer.
 *
 * Keyed by `card.fingerprint` (in `SwipeDeck`'s render) so each card gets its own
 * composer + action state and the form resets as the deck advances.
 */
function CommentComposer({
  card,
  owner,
  repo,
  prNumber,
  postComment,
}: {
  card: CardView;
  owner: string;
  repo: string;
  prNumber: number;
  postComment: SwipeDeckProps["postComment"];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(postComment, {
    ok: false,
  } as PostCommentResult);

  const target = card.commentAnchored
    ? `Posts a review comment on ${card.file} · ${card.highlightLabel}`
    : "Posts a comment to the PR conversation";

  return (
    <section className="mt-5 border-t border-border pt-4">
      {card.postedComments.length > 0 && (
        <div className="mb-3">
          <Eyebrow icon={<CheckCircle2 className="size-3.5" />}>Posted to GitHub</Eyebrow>
          <ul className="mt-2 flex flex-col gap-1">
            {card.postedComments.map((c) => (
              <li key={c.htmlUrl} className="text-sm leading-relaxed">
                <a
                  href={c.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-2 hover:brightness-110"
                >
                  {c.body.length > 80 ? `${c.body.slice(0, 80)}…` : c.body}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!open ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <MessageSquarePlus />
          Comment on PR
        </Button>
      ) : (
        <form action={formAction}>
          <input type="hidden" name="owner" value={owner} />
          <input type="hidden" name="repo" value={repo} />
          <input type="hidden" name="prNumber" value={prNumber} />
          <input type="hidden" name="fingerprint" value={card.fingerprint} />
          <p className="mb-2 text-xs text-muted-foreground">{target}</p>
          <Textarea name="body" required rows={3} placeholder="Leave a comment on this change…" />
          <div className="mt-2.5 flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Posting…" : "Post comment"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {state.ok && state.comment && (
            <p className="mt-2.5 flex items-center gap-1.5 text-sm text-success">
              <CheckCircle2 className="size-4" />
              Posted to GitHub{" "}
              <a
                href={state.comment.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                View comment
                <ExternalLink className="size-3.5" />
              </a>
            </p>
          )}
          {!state.ok && state.error && (
            <p role="alert" className="mt-2.5 text-sm text-destructive">
              {state.error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function CodeBlock({ card }: { card: CardView }) {
  if (card.code && card.code.length > 0) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        {/* Editor-style chrome: a header strip naming the lines to scrutinise. */}
        <div className="flex items-center gap-2 border-b border-border/70 bg-secondary/40 px-3 py-2">
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-[0.7rem] text-muted-foreground">
            {card.highlightLabel}
          </span>
        </div>
        <pre className="overflow-x-auto py-2 font-mono text-[0.78rem] leading-relaxed">
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
    <div className="rounded-lg border border-dashed border-border bg-background px-3 py-3 text-sm">
      <span className="text-foreground/80">{card.highlightLabel}</span>
      {card.removedLines > 0 && (
        <span className="ml-2 text-muted-foreground">
          ({card.removedLines} line{card.removedLines === 1 ? "" : "s"} removed)
        </span>
      )}
    </div>
  );
}

function CodeLineRow({ line }: { line: CodeLine }) {
  return (
    <div
      className={cn(
        "flex border-l-2",
        line.highlighted ? "border-l-tier-medium bg-tier-medium-fill" : "border-l-transparent",
      )}
    >
      <span className="inline-block w-10 shrink-0 select-none pr-2.5 text-right text-muted-foreground/50 tabular-nums">
        {line.number}
      </span>
      <span className="overflow-x-auto whitespace-pre pr-3">{line.text || " "}</span>
    </div>
  );
}

function ProgressBar({ done, total, percent }: { done: number; total: number; percent: number }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between text-xs" aria-hidden>
        <span className="font-medium text-foreground/80 tabular-nums">
          {done} / {total} reviewed
        </span>
        <span className="text-muted-foreground tabular-nums">{percent}%</span>
      </div>
      {/* Native progress carries the accessible semantics; the styled bar below is
          decorative so the dark theme renders consistently across browsers. */}
      <progress
        value={done}
        max={Math.max(total, 1)}
        aria-label="Deck review progress"
        className="sr-only"
      />
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** A drag-direction stamp that strengthens as the reviewer commits to a swipe. */
function IntentStamp({ intent, strength }: { intent: "good" | "flag"; strength: number }) {
  const good = intent === "good";
  return (
    <span
      style={{ opacity: 0.4 + strength * 0.6 }}
      className={cn(
        "pointer-events-none absolute top-4 z-10 inline-flex items-center gap-1.5 rounded-md border-2 px-2.5 py-1 text-xs font-bold uppercase tracking-wider",
        good
          ? "right-4 rotate-6 border-success text-success"
          : "left-4 -rotate-6 border-destructive text-destructive",
      )}
    >
      {good ? <Check className="size-3.5" /> : <X className="size-3.5" />}
      {good ? "Looks good" : "Flag"}
    </span>
  );
}

function DeckDone({ counts, total }: { counts: { up: number; down: number }; total: number }) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center">
      <div className="mx-auto mb-4 grid size-14 place-items-center rounded-full border border-success/40 bg-success/10 text-success">
        <CheckCircle2 className="size-7" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight">You've reviewed the whole deck</h2>
      <p className="mx-auto mt-2 max-w-md leading-relaxed text-muted-foreground">
        Every one of the {total} changed {total === 1 ? "chunk" : "chunks"} has been seen, the
        riskiest first. This is advisory — your swipes are signal, not a verdict.
      </p>
      <div className="mt-5 flex items-center justify-center gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-3 py-1.5 text-sm font-semibold text-success">
          <Check className="size-4" />
          {counts.up} looked good
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm font-semibold text-destructive">
          <X className="size-4" />
          {counts.down} flagged
        </span>
      </div>
    </div>
  );
}

/** A small uppercase section label, used for the card's content sections. */
function Eyebrow({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
      {icon}
      {children}
    </h2>
  );
}
