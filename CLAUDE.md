# diffsense

Quality-first, LLM-provider-agnostic, self-hosted GitHub PR review engine.

## Canonical docs

- @docs/ARCHITECTURE.md — layers, ports & adapters, the deterministic pipeline + agentic review unit
- @docs/STACK.md — locked tech stack and why
- @STRATEGY.md — what the product is, who it serves, how it wins

## Non-negotiable rules

- **`packages/core` imports no vendor SDK.** It is pure domain + Zod schemas + port interfaces. Everything I/O (LLM, GitHub, Postgres, ast-grep) is an adapter behind a port.
- **Provider-agnostic LLM:** call the `LLMProvider` port, never `@anthropic-ai/*` directly. Provider/model come from env.
- **Pipeline is deterministic; only the per-chunk review unit is agentic.** Keep ranking, chunk selection, delivery, and cost control deterministic.
- **Self-host only:** Docker, no serverless/edge, no managed-PaaS assumptions.

## Layout

`packages/core` (pure) · `packages/llm` (AI SDK adapter) · `apps/app` (ingress · queue · worker · pipeline · adapters) · `apps/web` (read-model UI)

## Work

Coding tasks live as GitHub issues (`ready-for-agent`). Start at #1; critical path #1 → #2 → #7 → #8.
