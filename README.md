# diffsense

**Reviewing AI code at AI speed.**

As AI writes more code, review is the bottleneck. diffsense points the reviewer at
the few changes that actually carry risk — fast, advisory, without leaving GitHub.

It ranks every diff hunk in a pull request by structural risk (size, risk-path,
API-boundary crossing, test-delta) and surfaces a "review these first" list, so
finite human attention lands on the changes most likely to hide a defect instead of
being spread evenly across a 1,000-line PR.

## Where things are

- [`STRATEGY.md`](STRATEGY.md) — what the product is, who it serves, how it wins.
- [`docs/ideation/`](docs/ideation/) — the candidate directions explored.
- [`docs/brainstorms/`](docs/brainstorms/) — the requirements for the first MVP: an
  8-week risk-ordering validation pilot.

Early-stage. The current goal is to validate one thesis: risk-ordered review finds
more real defects per review-minute than native GitHub order.
