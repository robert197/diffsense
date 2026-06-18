---
name: diffsense
last_updated: 2026-06-18
---

# diffsense Strategy

## Target problem

AI lets teams generate code faster than humans can review it, making the reviewer
the bottleneck. Large AI-generated PRs arrive in file order, so reviewers fatigue
and skim the tail where the risky change hides — defect detection falls from 87%
on small PRs to 28% on large ones, and 61% of AI PRs get no real review at all.
Review attention is finite and mis-allocated, and unlike code generation it can't
be scaled by producing more of it.

## Our approach

Win by owning the reviewer's attention allocation, not by writing more AI comments.
Direct finite human attention to the riskiest changes first using cheap structural
signals, earn trust by staying advisory and inside GitHub, then compound through a
review-memory data moat. The bet against every competitor's inline-AI-comment
paradigm: the scarce resource is reviewer attention, not AI output — so we optimize
where humans look, not how much the AI says.

## Who it's for

**Primary:** The Reviewer on a team shipping AI-generated code at volume — hiring
diffsense to find the real problems in a big PR without reading all of it or
rubber-stamping it.

**Buyer / sponsor:** The Eng-Manager whose velocity is going flat despite more
output, hiring diffsense for review throughput without a loss in quality.

## Key metrics

- **Caught-defects per review-minute** - north star; do risk-ordered reviews find
  more real issues per minute than native-order control. Measured via PR-thread
  A/B (actionable comments vs review-time).
- **Reviewer engagement / retention** - % of reviewers still acting on the ranking
  by week 2. Leading, weekly; regresses when the surface stops earning attention.
- **Risk-flag precision** - 👍/👎 ratio on flagged chunks. Regresses when the
  ranking degrades.
- **Split/merge correction rate over time** - falls as the chunk model learns the
  team's boundaries; the moat signal (forward-looking, once splitting ships).
- **Escaped-defect rate** - reverts/hotfixes traced to reviewed PRs. Lagging,
  secondary check on real quality.

## Tracks

### Risk Intelligence

The ranking and scoring engine — structural signals now, semantic later — that
decides which changes deserve attention first.

_Why it serves the approach:_ It is the mechanism that turns "direct attention to
risk" from a slogan into a computed ordering.

### Reviewer Experience

The advisory in-GitHub surface today; the card/triage UI and anti-rubber-stamp
friction later. Everything the reviewer actually touches.

_Why it serves the approach:_ Owning the reviewer's flow — without forcing them out
of GitHub — is how trust is earned before any authority is claimed.

### Review Memory

The chunk-fingerprint, precedent-recall, and split-learning data flywheel that
sharpens with every review.

_Why it serves the approach:_ It is the compounding moat a funded competitor can't
copy without the same review history.

## Milestones

- **2026** - 8-week risk-ordering validation pilot across ~10 teams shipping
  AI-generated code at volume; go/kill on the caught-defects-per-minute thesis.

## Not working on

- Merge-gating or enforcement — the product stays advisory until trust is earned.
- Manager-facing surveillance dashboards — anti-rubber-stamp signals belong to the reviewer as coaching.
- Shift-left interception into the code-generation agent loop — a different product.
- Swipe/card UI and AI per-chunk explanations — deferred until the ordering thesis is validated.

## Marketing

**One-liner:** Reviewing AI code at AI speed.

**Key message:** As AI writes more code, review is the bottleneck — diffsense points
the reviewer at the few changes that actually carry risk, fast, without leaving
GitHub. (Internal: never pitched as "Tinder for code review.")
