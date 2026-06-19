---
title: "feat: Context tools for the review unit (RepoReader + CodeSearch + ConventionStore)"
date: 2026-06-19
type: feat
status: ready
origin: GitHub issue #7
---

# feat: Context tools for the review unit (RepoReader + CodeSearch + ConventionStore)

## Summary

Issue #7 delivers the **context layer** the agentic review unit (#8) will pull from. It is
ports + adapters + a thin tool layer — no review loop yet. Three pure ports land in
`packages/core/ports` (`RepoReader`, `CodeSearch`, `ConventionStore`), their adapters land in
`apps/app/adapters` (Octokit, ast-grep, Drizzle), and a pure tool factory in
`packages/core/review` exposes the four named tools (`read_file`, `find_call_sites`,
`get_pr_intent`, `read_conventions`) in a provider-agnostic shape #8 can hand to the LLM.

This is one tracer-bullet slice. It wires the seams; #8 calls them.

---

## Problem Frame

The review unit (#8) must decide *per chunk* what context it needs — enclosing function, blast
radius of a changed symbol, PR intent, learned repo conventions — instead of one pre-assembled
bundle (docs/ARCHITECTURE.md §3). For that, #8 needs primitive tools backed by ports that
`core` owns and adapters in `apps/app` implement. None of these exist yet. This slice builds
them, fully unit-tested with fakes, so #8 has a stable surface to call.

---

## Requirements (from issue #7)

- R1. `core/ports` defines `RepoReader`, `CodeSearch`, `ConventionStore` as pure interfaces
  (no vendor import).
- R2. github adapter resolves a file range and PR intent via Octokit (tested with a fake Octokit).
- R3. search adapter finds call sites of a changed symbol via ast-grep, returns bounded results;
  unresolved symbols yield an empty list, never an error (tested).
- R4. `ConventionStore` reads/writes per-repo convention notes (round-trip test).
- R5. The four tools (`read_file`, `find_call_sites`, `get_pr_intent`, `read_conventions`) are
  exposed in a shape the review unit (#8) can consume.

---

## Key Technical Decisions

- **KTD1 — Tool shape is framework-agnostic.** `core` cannot import the AI SDK (non-negotiable
  rule). Define a plain `ReviewTool<I, O>` descriptor: `{ name, description, inputSchema (Zod),
  execute(input) }`. A pure `createReviewTools(ports)` factory wires the four tools to injected
  ports. #8's `packages/llm` adapter maps these to AI SDK `tool()` objects — the Zod schema is
  already the shared contract (docs/STACK.md). This keeps `core` pure and gives #8 exactly the
  "shape it can consume."
- **KTD2 — `RepoReader` is PR-scoped, built by the adapter.** `readFile(path, range?)` and
  `getPrIntent()` take no repo coords; the github adapter closes over `{ owner, repo, prNumber,
  ref }` at construction (mirrors how `handlePullRequestEvent` already holds coords). Range is
  `{ start, end }` 1-based inclusive line numbers; omitted range returns the whole file.
- **KTD3 — `CodeSearch` operates over injected file sources, never the filesystem.** The adapter
  takes the candidate files as `{ path, source }` records (the worker in #8 supplies them from
  the fetched PR / repo tree). This keeps the adapter testable without a checkout and bounded by
  construction. Per-file language is inferred from extension; unknown extensions are skipped.
- **KTD4 — Search never throws (R3).** Each file parse + match is wrapped; any ast-grep error
  skips that file. An unresolved symbol simply matches nothing → empty list. Results are capped
  by a `maxResults` budget (default 50).
- **KTD5 — `ConventionStore` is keyed by `{ owner, repo }`, last-write-wins.** New `conventions`
  table: one notes row per repo, upserted. `readConventions` returns the notes string or `null`
  when none exist (the agent's accumulated `context.md`, docs/ARCHITECTURE.md §5).

---

## Implementation Units

### U1. Define the three ports in `core`

**Goal:** Pure interfaces + shared types for the context layer (R1).
**Requirements:** R1.
**Dependencies:** none.
**Files:**
- `packages/core/src/ports/repoReader.ts` (new)
- `packages/core/src/ports/codeSearch.ts` (new)
- `packages/core/src/ports/conventionStore.ts` (new)
- `packages/core/src/index.ts` (modify — export the ports + types)

**Approach:**
- `RepoReader`: `readFile(path: string, range?: LineRange): Promise<string | null>` (null when
  the file does not exist), `getPrIntent(): Promise<PrIntent>` where `PrIntent = { title: string;
  body: string }`. `LineRange = { start: number; end: number }` (1-based inclusive).
- `CodeSearch`: `findCallSites(symbol: string): Promise<CodeReference[]>`,
  `findSymbol(name: string): Promise<CodeReference[]>`. `CodeReference = { path: string; line:
  number; text: string }`.
- `ConventionStore`: `readConventions(repo: RepoRef): Promise<string | null>`,
  `writeConventions(repo: RepoRef, notes: string): Promise<void>`. `RepoRef = { owner: string;
  repo: string }`.
- Match the doc-comment style of `ports/reactionStore.ts` (ports-and-adapters note).

**Patterns to follow:** `packages/core/src/ports/reactionStore.ts`, the `export type` lines in
`packages/core/src/index.ts`.
**Test scenarios:** Test expectation: none — pure type/interface declarations, no behavior.
Compilation under `tsc --noEmit` and the consuming adapters' tests prove the shapes.
**Verification:** `pnpm typecheck` passes; ports are importable from `@diffsense/core`.

### U2. GitHub adapter implements `RepoReader`

**Goal:** Resolve a file range and PR intent via Octokit (R2).
**Requirements:** R2.
**Dependencies:** U1.
**Files:**
- `apps/app/src/adapters/repoReader.ts` (new)
- `apps/app/src/adapters/repoReader.test.ts` (new)

**Approach:**
- `createGitHubRepoReader(octokit, { owner, repo, prNumber, ref })` returns a `RepoReader`.
- Extend the local structural `GitHubClient`-style interface (as `adapters/github.ts` does) with
  the `rest.repos.getContent` and reuse `rest.pulls.get` surfaces this adapter needs — type
  against a minimal subset so tests pass a fake.
- `readFile`: call `repos.getContent({ owner, repo, path, ref })`; decode base64 `content`;
  when `range` given, slice lines `start..end` (1-based inclusive, clamped). Return `null` on
  404 (file absent) — catch the Octokit not-found error rather than throwing.
- `getPrIntent`: `pulls.get({ owner, repo, pull_number })` → `{ title, body: body ?? "" }`.

**Patterns to follow:** the minimal-structural-interface + fake-client approach in
`apps/app/src/adapters/github.ts`; test style in `apps/app/src/worker/handlePullRequestEvent.test.ts`.
**Test scenarios:**
- Covers R2. `readFile` with no range returns the full decoded file content.
- `readFile` with `{ start: 2, end: 3 }` returns only those lines, joined.
- `readFile` range past EOF clamps to available lines (no error).
- `readFile` returns `null` when getContent raises a 404-shaped error.
- `getPrIntent` returns `{ title, body }` from `pulls.get`; missing body becomes `""`.
**Verification:** adapter tests green; no `@octokit/*` value import in `core`.

### U3. Search adapter implements `CodeSearch` via ast-grep

**Goal:** Find call sites / symbol defs, bounded, never throws (R3).
**Requirements:** R3.
**Dependencies:** U1.
**Files:**
- `apps/app/src/adapters/codeSearch.ts` (new)
- `apps/app/src/adapters/codeSearch.test.ts` (new)
- `apps/app/package.json` (modify — add `@ast-grep/napi`)
- root `package.json` (modify — add `@ast-grep/napi` to `pnpm.onlyBuiltDependencies` so its
  native binary is built on install)

**Approach:**
- `createAstGrepCodeSearch({ files, maxResults? })` where `files: Array<{ path: string; source:
  string }>` and `maxResults` defaults to 50. Returns a `CodeSearch`.
- Per file, infer `Lang` from extension over the JS/TS family that `@ast-grep/napi` bundles
  natively (`.ts`→TypeScript, `.tsx/.jsx`→Tsx, `.js/.cjs/.mjs`→JavaScript). Other extensions
  skip the file (contribute nothing) — adding a language is registering an `@ast-grep/lang-*`
  pack, not a code change here.
- `findCallSites(symbol)`: `parse(lang, source).root().findAll(\`${symbol}($$$ARGS)\`)`; each
  match → `{ path, line: range().start.row + 1, text }`. Stop once `maxResults` reached.
- `findSymbol(name)`: search a small set of definition patterns per language family
  (`function ${name}`, `const ${name} =`, `class ${name}`); dedupe by path+line.
- Wrap each file's parse+match in try/catch; on any error skip that file. Empty/garbage symbol
  or no match → `[]` (R3, never throws).

**Patterns to follow:** adapter factory + injected-dependency style of
`apps/app/src/adapters/reactionStore.ts`.
**Test scenarios:**
- Covers R3. `findCallSites("doThing")` over a TS source with two `doThing(...)` calls returns
  two refs with correct 1-based line numbers and paths.
- `findCallSites` respects `maxResults` (cap at the budget).
- `findCallSites("nonexistentSymbol")` returns `[]`.
- `findCallSites` with a deliberately unparseable / wrong-extension file returns `[]` and does
  not throw.
- `findSymbol("Foo")` locates a `class Foo` / `function Foo` / `const Foo =` definition.
- A `.png`-extension or unknown-extension file is skipped without error.
**Verification:** adapter tests green; install builds `@ast-grep/napi` on this platform.

### U4. Drizzle adapter implements `ConventionStore` + table/migration

**Goal:** Per-repo convention notes read/write round-trip (R4).
**Requirements:** R4.
**Dependencies:** U1.
**Files:**
- `apps/app/src/db/schema.ts` (modify — add `conventions` table)
- `apps/app/src/db/migrations/0002_conventions.sql` (new)
- `apps/app/src/db/migrations/meta/_journal.json` (modify — add the migration entry)
- `apps/app/src/adapters/conventionStore.ts` (new)
- `apps/app/src/db/db.test.ts` (modify — add the round-trip test under the existing skipIf block)

**Approach:**
- `conventions` table: `id serial pk`, `owner text`, `repo text`, `notes text`, `updated_at
  timestamptz default now()`, with a unique constraint on `(owner, repo)` so upsert is clean.
- `createDrizzleConventionStore(db)` returns a `ConventionStore`.
  - `readConventions({ owner, repo })`: select notes where owner+repo match; return `notes` or
    `null`.
  - `writeConventions({ owner, repo }, notes)`: insert; on conflict `(owner, repo)` update
    `notes` + `updated_at` (Drizzle `onConflictDoUpdate`).
- Generate the SQL via `drizzle-kit generate` if convenient, else hand-write the migration to
  match the existing `0001_reactions.sql` style, and append the `_journal.json` entry.

**Patterns to follow:** `reactions` table in `apps/app/src/db/schema.ts`;
`createDrizzleReactionStore` in `apps/app/src/adapters/reactionStore.ts`; the existing
`describe.skipIf(!databaseUrl)` round-trip in `apps/app/src/db/db.test.ts`.
**Test scenarios:**
- Covers R4. Round-trip: `readConventions` returns `null` for an unknown repo; after
  `writeConventions(repo, "note A")`, read returns `"note A"`; after a second write `"note B"`,
  read returns `"note B"` (last-write-wins, single row per repo). Runs under the existing
  `skipIf(!DATABASE_URL)` guard so it is a no-op locally and exercised in CI/compose.
**Verification:** db test green when `DATABASE_URL` is set; schema + migration + journal consistent.

### U5. Tool factory exposes the four named tools

**Goal:** Expose `read_file`, `find_call_sites`, `get_pr_intent`, `read_conventions` in a
provider-agnostic shape #8 consumes (R5).
**Requirements:** R5.
**Dependencies:** U1.
**Files:**
- `packages/core/src/review/tools.ts` (new)
- `packages/core/src/review/tools.test.ts` (new)
- `packages/core/src/index.ts` (modify — export `ReviewTool`, `createReviewTools`, input schemas)

**Approach:**
- Define `ReviewTool<I, O> = { name: string; description: string; inputSchema: ZodType<I>;
  execute: (input: I) => Promise<O> }`.
- `createReviewTools(ports: { repoReader: RepoReader; codeSearch: CodeSearch; conventionStore:
  ConventionStore; repo: RepoRef })` returns the four tools:
  - `read_file` → `repoReader.readFile(path, range?)`; input schema `{ path, range? }`.
  - `find_call_sites` → `codeSearch.findCallSites(symbol)`; input `{ symbol }`.
  - `get_pr_intent` → `repoReader.getPrIntent()`; input `{}` (empty object schema).
  - `read_conventions` → `conventionStore.readConventions(repo)`; input `{}`.
- Each tool carries a one-line `description` written for the LLM (what it returns, when to call
  it), mirroring docs/ARCHITECTURE.md §3.
- Define Zod input schemas as named exports so #8 / `packages/llm` can reuse them.

**Patterns to follow:** Zod schema style in `packages/core/src/schemas/reaction.ts`; export style
in `packages/core/src/index.ts`.
**Test scenarios:**
- Covers R5. `createReviewTools` with fake ports returns exactly four tools named `read_file`,
  `find_call_sites`, `get_pr_intent`, `read_conventions`.
- Each tool's `inputSchema` parses a valid input and rejects an invalid one (e.g. `read_file`
  requires `path`).
- `read_file.execute({ path, range })` delegates to `repoReader.readFile` with the same args.
- `find_call_sites.execute({ symbol })` delegates to `codeSearch.findCallSites`.
- `get_pr_intent.execute({})` delegates to `repoReader.getPrIntent`.
- `read_conventions.execute({})` delegates to `conventionStore.readConventions` with the bound
  `repo`.
**Verification:** `pnpm test` green; tools importable from `@diffsense/core`.

---

## Scope Boundaries

In scope: the three ports, their three adapters, the tool factory, and tests for each.

### Deferred to Follow-Up Work
- The review loop that calls these tools — issue #8.
- The `packages/llm` mapping of `ReviewTool` → AI SDK `tool()` — issue #8.
- Wiring the adapters into the worker / `runReview` shell — issue #8.
- Convention *refinement* from reactions (write path beyond round-trip) — later moat work
  (docs/ARCHITECTURE.md §5).

---

## Risks & Dependencies

- **`@ast-grep/napi` native binary.** New native dependency; must build on install (darwin dev +
  Docker). Add to `pnpm.onlyBuiltDependencies`. If install fails on the target platform, the
  search adapter is the only blocked unit — ports, github, and db adapters are independent.
- **No GitHub Actions CI in this repo.** Verification is local: `pnpm test`, `pnpm lint`,
  `pnpm typecheck`. The db round-trip test self-skips without `DATABASE_URL`.

---

## System-Wide Impact

Net-new files plus three small edits to `index.ts`, `schema.ts`, and `db.test.ts`. No existing
behavior changes — nothing calls the new ports yet (that is #8). The migration adds one table;
it is additive and does not touch `processed_events` or `reactions`.
