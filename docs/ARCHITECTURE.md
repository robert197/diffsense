# diffsense — Architecture

Clean, layered, small components. The guiding shape: **a deterministic pipeline with agentic review units** — determinism at the boundaries (which chunks, cost ceiling, idempotent delivery), judgment in the middle (what is risky, what to explain, what to refute). Grounded in [`docs/STACK.md`](STACK.md) and the v2 requirements.

## 1. The one rule: ports & adapters, dependency points inward

```
        ┌──────────────────────────────────────────────────────┐
        │  apps/app  (I/O shell, composition root)              │
        │  ingress · queue · worker · pipeline                  │
        └───────────────┬───────────────────────┬──────────────┘
                        │ wires adapters          │ writes read-model
                        ▼                         ▼
        ┌──────────────────────────────┐   ┌───────────────────┐
        │  packages/core (PURE domain) │   │ apps/web (Next.js)│
        │  types · Zod schemas · logic │   │ read-model UI     │
        │  + PORT interfaces           │   └───────────────────┘
        └──────────────┬───────────────┘
                        │ implemented by
        ┌───────────────┴───────────────────────────────────────┐
        │  adapters: llm (AI SDK) · github (Octokit)             │
        │            search (ast-grep) · db (Drizzle/Postgres)   │
        └───────────────────────────────────────────────────────┘
```

- **`core` imports nothing vendor-specific.** It defines *ports* (interfaces) and pure logic. It never knows it's talking to Anthropic, GitHub, or Postgres.
- **Adapters implement ports.** Swap Anthropic→Gemini, or Postgres→anything, by replacing an adapter — `core` is untouched. This is also what makes the LLM-provider independence and the self-host constraint cheap.
- **`apps/app` is the only place that knows the real world** — it wires concrete adapters into `core` and runs the pipeline. **`apps/web`** is a read-model over the same stores.

### Ports (the seams everything plugs into)

| Port (in `core`) | Implemented by | Used by |
|---|---|---|
| `LLMProvider` | `packages/llm` (Vercel AI SDK) | review, verify, synthesis |
| `RepoReader` (read file/range, PR intent) | github adapter (Octokit) | review tools |
| `CodeSearch` (find call sites / symbols) | search adapter (ast-grep) | review tools (blast radius) |
| `GitHubGateway` (post/edit comment) | github adapter (Octokit) | delivery |
| `FingerprintCache` · `FindingStore` · `ReactionStore` · `CostStore` · `ConventionStore` | db adapter (Drizzle) | pipeline + web |

## 2. The pipeline: deterministic shell

The worker runs a fixed, testable sequence. The sequence is hardcoded **on purpose** — it is cost/attention control, not domain judgment.

```
PR webhook ─► rankHunks (pure, no LLM)
            ─► pick top-K + reviewer-opened chunks      ◄── cost ceiling lives here
            ─► for each chunk:  ReviewUnit (agentic) ──► ChunkReview
            ─► verifyFinding (per finding)            ──► drop/keep + verdict
            ─► detectScopeCreep (whole diff vs intent)
            ─► synthesizePortfolio (all verified findings)
            ─► renderComment ─► GitHubGateway.upsert (idempotent)
            ─► recordCost
```

Each stage is a **small pure function in `core`** taking injected ports. The shell is `runReview(prRef, ports)` — one function, fully unit-testable with fake ports.

**What stays deterministic and why:**
- `rankHunks` — structural, AUC 0.96, deterministic order reviewers trust. No LLM.
- chunk selection — bounds inference to top-risk + opened. The margin guard.
- comment upsert — exactly one comment, edited in place. Idempotent delivery.

## 3. The review unit: where it goes agentic

This is the one place the agent-native principles earn their place. Instead of pre-assembling a fixed context blob and one-shotting it, the **ReviewUnit is a small bounded agent loop** that pulls exactly the context a given chunk needs — the way a senior reviewer follows a thread.

```
ReviewUnit(chunk, ports)         system prompt = "what a good review is"
  loop (bounded tool budget):
    read_file(path, range)       ◄ RepoReader   — enclosing fn, neighbours
    find_call_sites(symbol)      ◄ CodeSearch   — blast radius
    get_pr_intent()              ◄ RepoReader   — PR title/description
    read_conventions()           ◄ ConventionStore — learned repo norms
    complete_review(ChunkReview) ─► structured, Zod-validated → done
```

- **Primitive tools, not a workflow.** The tools fetch context; the *prompt* defines the review. To change review behavior you edit prose, not code (composability).
- **The agent decides what it needs.** A trivial rename pulls nothing; a signature change pulls call sites. This is the Greptile-style context edge — but bounded by the shell (only top-risk chunks reach here) so it never runs away on a 4,000-line PR.
- **Explicit completion.** `complete_review` returns the schema-validated `ChunkReview` — no heuristic "did it finish?" detection.
- **Output is data, schema-enforced.** `ChunkReview = { explanation, claims[], rating, reasons[] }` via Zod → the same shape across any LLM provider.

**Verify, scope, synthesis are single structured calls, not loops** — their inputs are already in hand (the finding + its context; the diff + intent; the verified findings). Explore only where context is unknown; one-shot where it isn't. Clean line.

## 4. Components (small, one job each)

```
packages/core
  diff/        parseHunks · demote · fingerprint
  rank/        rankHunks · bucket
  review/      reviewUnit (loop) · tool contracts · ChunkReview schema
  verify/      verifyFinding
  scope/       detectScopeCreep
  synthesis/   synthesizePortfolio
  render/      renderComment
  ports/       LLMProvider · RepoReader · CodeSearch · GitHubGateway · *Store
  schemas/     Zod: ChunkReview · Finding · Portfolio · Conventions

packages/llm   LLMProvider adapter (AI SDK; provider+model from env)

apps/app
  ingress/     Hono endpoint · webhook signature verify
  queue/       BullMQ producer
  worker/      consumer → runReview(prRef, ports)   (composition root)
  pipeline/    runReview shell (stage sequencing)
  adapters/    github (Octokit) · search (ast-grep) · db (Drizzle)

apps/web        Next.js read-model: cards, claims + refute affordance
```

Rule of thumb: a file in `core/` is a pure function or a type. Anything that does I/O is an adapter behind a port.

## 5. Improvement over time (the moat, as architecture)

Two stores turn each review into an asset:

- **`ConventionStore`** — per-repo learned norms, read by the review unit (`read_conventions`) and refined as reviews + reactions accumulate. This is the agent's `context.md`: accumulated knowledge that makes the *next* review sharper without shipping code.
- **`FingerprintCache`** — per-chunk explanation keyed by an AST/structural fingerprint. A recurring chunk reuses its review; reviewer reactions (👍/👎, refutes) tune which cached findings stay trusted.

Both are plain stores behind ports — no agent magic, just compounding data.

## 6. Agent → UI parity (shared store, no silent actions)

The hosted card view is a **read-model over `FindingStore`** — it shows exactly what the pipeline produced. Reviewer reactions and claim-refutes write back through `ReactionStore`, the same store the pipeline and the fingerprint cache read. One data space, no divergence: a refute in the UI immediately becomes signal the engine learns from.

## 7. Self-host & provider independence fall out of the design

- **Provider independence** is just the `LLMProvider` port + the AI SDK adapter; `core` never sees a vendor. Switch via `LLM_PROVIDER` / `REVIEW_MODEL` / `SYNTHESIS_MODEL`.
- **Self-host** is just composition: one Docker image, three roles (`serve`/`worker`/`web`), `docker-compose` with postgres + redis + caddy. The architecture has no PaaS assumptions — `DATABASE_URL`/`REDIS_URL` are ports too, in effect.

## 8. What is deliberately NOT agent-native

Honest scope: diffsense is not a chat app with an open-ended agent and full UI parity. The reviewer interacts through GitHub and a read-only card view, not by commanding an agent. So we adopt the principles that fit — **primitives-not-workflows, prompt-defined review, explicit completion, accumulated-context, shared store** — and we deliberately keep **ranking, chunk selection, delivery, and cost control deterministic**. Forcing those into a loose agent would trade away the determinism and cost guarantees that make the product trustworthy and viable.

## 9. Map to issues

| Issue | Lands in |
|---|---|
| #1 scaffold + ingress + worker + Docker | `apps/app` (ingress, queue, worker, adapters skeleton), compose |
| #2 structural ranking | `core/rank` + `core/diff` |
| #3 robustness + reactions | `core/diff` (demote/fallback) + `ReactionStore` |
| #7 context → **review tools** | `core/ports` (RepoReader, CodeSearch) + adapters; reframed from "fixed bundle" to the tool set the review unit calls |
| #8 review unit + fingerprint cache | `core/review` + `packages/llm` + `FingerprintCache` |
| #9 adversarial verify | `core/verify` |
| #10 scope-creep | `core/scope` |
| #11 portfolio synthesis | `core/synthesis` |
| #12 comment + cost | `core/render` + `GitHubGateway` + `CostStore` |
| #13 card view | `apps/web` over `FindingStore`/`ReactionStore` |

> **Note on #7:** the architecture upgrades it from "assemble a fixed context bundle" to "expose context as primitive tools the review unit calls on demand." Same dependency (#8 builds on #7), better reviews, more agent-native. Worth updating the issue body before that slice is grabbed.
