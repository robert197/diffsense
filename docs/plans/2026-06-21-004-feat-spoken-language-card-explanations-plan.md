---
title: "feat: Spoken-language choice for card explanations"
type: feat
date: 2026-06-21
issue: 28
status: ready
depth: standard
---

# feat: Spoken-language choice for card explanations

Localize each swipe-deck card's plain-language **explanation** and "what could be
wrong" **suggestions** into a spoken language the reviewer picks. Code,
identifiers, file paths, risk scores, tiers, and highlighted line ranges stay
exactly as-is — only natural-language prose is translated. Translation goes
through the provider-agnostic `LLMProvider` port, is cached per card + language so
re-opening never re-spends inference, and falls back to English whenever
localization is unavailable.

**Issue:** #28 (`ready-for-agent`). Blocked-by #26 (merged) and builds on #27's
swipe deck. The PR closes #28.

---

## Problem Frame

Non-English-proficient developers abandon AI-tool output at a markedly higher rate
(25% vs 17.9%, FSE 2025) — linguistic inequity, not capability. diffsense's edge is
owning reviewer attention (STRATEGY.md); a reviewer who can't read the card's prose
can't allocate attention to it. Localizing the card's natural language widens who
can review effectively without touching the deterministic risk signal.

Today every card renders English-only: `Card.explanation` and `Card.suggestions`
are produced once by `buildDeck` (pure, deterministic) and persisted in the `decks`
table; `apps/web` reads them back and the `SwipeDeck` renders them verbatim. There
is no language choice and no translation path.

---

## Scope

**In scope**
- A reviewer-selectable spoken language (per-session cookie; default English).
- Read-time, on-demand translation of each card's `explanation` + `suggestions`
  into the chosen language via the `LLMProvider` port.
- A persistent cache keyed by `(owner, repo, fingerprint, language)` so a card is
  translated once per language and reused on re-open.
- Graceful English fallback when localization is unavailable (no provider key,
  provider error, unsupported language).
- The `SwipeDeck` renders localized prose; everything non-prose is untouched.

**Out of scope / deferred** (route to follow-up, not this PR)
- Persisting the language choice on a user *profile* row (we use a per-session
  cookie; `web_sessions` profile storage is a separate slice).
- Translating the GitHub PR comment, the findings-list view (#13), or any surface
  other than the swipe deck.
- Localizing UI chrome / button labels (i18n of the app shell) — only card prose.
- Pre-generating translations at deck-build time for all languages (wasteful; we
  translate on demand for the language actually requested).
- Streaming/progressive translation; cache-staleness invalidation when the English
  source text changes for an unchanged fingerprint (same accepted limitation the
  fingerprint review cache already carries).

---

## Key Technical Decisions

**KTD1 — Translate at read time in `apps/web`, not in the worker pipeline.**
The reviewer picks their language while viewing the deck, so the language is only
known at read time. Building every language up front is wasteful and we don't know
which languages reviewers want. `apps/web` already does its own server-side I/O
(GitHub content reads, direct Drizzle reads via `lib/deck.ts` / `lib/findings.ts`),
so adding the translate-on-read step there is consistent with the existing
read-model shape. The deterministic worker pipeline (`processPrIntoDeck`) is left
untouched — decks are still built in English.

**KTD2 — Localization is a single structured `LLMProvider` call, not an agent
loop.** This preserves the non-negotiable "deterministic pipeline; only the review
unit is agentic." `localizeCard` mirrors `verifyFinding` / `detectScopeCreep` /
`synthesize`: the inputs (the prose + target language) are already in hand, so it
is one `generateText` + `Output.object` call against a Zod schema — no tools, no
loop. `core` gains the port method; `packages/llm` implements it; `core` never
imports a vendor SDK.

**KTD3 — Cache keyed by `(owner, repo, fingerprint, language)`.** This mirrors the
`fingerprints` review-cache keying exactly (`owner, repo, fingerprint`) plus the
target `language`. A card's prose is derived from the finding keyed by its
structural fingerprint, so this key dedupes translations across PRs and re-runs.
New table `card_localizations`; the canonical schema + migration live in
`apps/app` (the migration home, same as `web_sessions`/`decks`), and `apps/web`
mirrors the table in `lib/db.ts` and is the only reader/writer — the exact pattern
`decks` and `web_sessions` already follow.

**KTD4 — English is a pure passthrough.** When the chosen language is `en`
(the default and source language) the orchestration returns the cards unchanged
with zero provider/store I/O. This satisfies "code/identifiers/risk not altered"
trivially for the common case and keeps the default path free of inference.

**KTD5 — Language choice is a per-session cookie.** Simplest mechanism that
satisfies "user picks a language (profile or per-session setting)"; no schema
change to `web_sessions`. A server action validates the code against the supported
set and sets the `df_lang` cookie; the deck page reads it. Unknown/empty → English.

**KTD6 — `apps/web` depends on `@diffsense/llm`.** The provider adapter is the only
sanctioned LLM seam; the web read path constructs it from env exactly like
`apps/app` does. Requires adding `@diffsense/llm` to the web build's
`transpilePackages` (same reason `@diffsense/core` is there — pure-TS workspace
package, no compiled dist).

---

## High-Level Technical Design

Read-path data flow when a reviewer opens the deck in a non-English language:

```
DeckPage (server component)
  ├─ cookies() ──► resolveLanguage("df_lang")  ─► LanguageCode (default "en")
  ├─ getLatestDeck() ─► Deck { cards: Card[] (English) }
  │
  ├─ language === "en" ?
  │     yes ─► cards unchanged ──────────────────────────────┐  (no inference)
  │     no  ─► localizeDeckCards(cards, language, {owner,repo})│
  │             for each card (bounded concurrency):           │
  │               store.get(owner,repo,fingerprint,language)   │
  │                 hit  ─► reuse cached {explanation,sugg.}   │
  │                 miss ─► llm.localizeCard(...) ─► save ──┐  │
  │                          provider error ─► English ◄───┘  │
  │                                                            ▼
  └─ buildCardViews(localizedCards) ─► toCardView ─► SwipeDeck (renders prose)

LanguagePicker (server <form action={setLanguage}>) ─► sets df_lang cookie ─► reload
```

Layer ownership (ports & adapters, dependency inward):

```
packages/core (pure)                    packages/llm (adapter)
  schemas/localization.ts                 createReviewProvider().localizeCard
  ports/llmProvider.ts  (+localizeCard)     = generateText + Output.object(LocalizedCardSchema)
  ports/localizationStore.ts
  localize/localizeCards.ts  ◄── injected ports ──┐
                                                  │
apps/app (schema home)                  apps/web (read-model + composition)
  db/schema.ts (card_localizations)       lib/db.ts (mirror table)
  db/migrations/0008_*.sql                lib/localize.ts (store impl + provider wiring)
                                          lib/language.ts (cookie → LanguageCode)
                                          deck/page.tsx, LanguagePicker.tsx, actions.ts
```

---

## Implementation Units

### U1. Core localization schemas + language set

**Goal:** The pure domain vocabulary for localization — supported languages and the
localized-prose shape — with no I/O and no vendor import.

**Requirements:** AC "user can select a spoken language" (the supported set);
AC "produced via LLMProvider … cached" (the `LocalizedCard` shape both port and
store speak).

**Dependencies:** none.

**Files:**
- `packages/core/src/schemas/localization.ts` (new)
- `packages/core/src/schemas/localization.test.ts` (new)
- `packages/core/src/index.ts` (export the new symbols)

**Approach:**
- `LANGUAGE_CODES = ["en","es","fr","de","pt","zh","ja","hi","ar","ru"] as const`
  (a bounded, curated set; English first/source). `LanguageCodeSchema =
  z.enum(LANGUAGE_CODES)`; `type LanguageCode`.
- `SUPPORTED_LANGUAGES: { code: LanguageCode; label: string }[]` — native-name
  labels for the picker (e.g. `es → "Español"`, `zh → "中文"`).
- `DEFAULT_LANGUAGE: LanguageCode = "en"`.
- `isSupportedLanguage(x: string): x is LanguageCode` and
  `resolveLanguage(x: string | undefined | null): LanguageCode` (falls back to
  `DEFAULT_LANGUAGE`). These centralize fallback so web + actions share one rule.
- `LocalizedCardSchema = z.object({ explanation: z.string().min(1), suggestions:
  z.array(z.string().min(1)) })`; `type LocalizedCard`. This is the localizable
  slice of `Card` — deliberately a subset, so a localization can never alter
  `fingerprint`, `file`, `tier`, `rank`, `riskScore`, or `highlights`.

**Patterns to follow:** `packages/core/src/schemas/card.ts` (Zod object + inferred
type + doc comment); enum style in `schemas/chunkReview.ts`.

**Test scenarios:**
- `resolveLanguage("es")` → `"es"`; `resolveLanguage("xx")`, `undefined`, `""`,
  `null` → `"en"`.
- `isSupportedLanguage` true for each `LANGUAGE_CODES` member, false for `"xx"`.
- `LANGUAGE_CODES` includes `"en"`; `SUPPORTED_LANGUAGES` has one entry per code,
  every label non-empty, codes unique.
- `LocalizedCardSchema` accepts `{explanation:"x", suggestions:[]}`; rejects empty
  `explanation` and a `suggestions` entry that is an empty string.

### U2. `LLMProvider.localizeCard` port + `LocalizationStore` port

**Goal:** Define the two seams localization plugs into — the provider method that
translates and the cache that stores results — and update every existing
`LLMProvider` fake so the interface change compiles.

**Requirements:** AC "produced via the LLMProvider port and cached per
card/language."

**Dependencies:** U1.

**Files:**
- `packages/core/src/ports/llmProvider.ts` (add `LocalizeRequest` + interface method)
- `packages/core/src/ports/localizationStore.ts` (new)
- `packages/core/src/index.ts` (export `LocalizeRequest`, `LocalizationStore`,
  `LocalizationKey`)
- Fakes to extend with `localizeCard: vi.fn()` so `: LLMProvider` literals still
  satisfy the interface:
  - `packages/core/src/verify/verifyFinding.test.ts` (2 literals)
  - `packages/core/src/scope/detectScopeCreep.test.ts` (2 literals)
  - `packages/core/src/synthesis/synthesizePortfolio.test.ts` (1 literal)
  - `packages/core/src/review/reviewPass.test.ts` (1 literal)
  - `packages/core/src/review/reviewFindings.test.ts` (1 literal)

**Approach:**
- `LocalizeRequest { explanation: string; suggestions: readonly string[];
  language: LanguageCode }` — the English source prose plus the target language
  (never `"en"`; the orchestration never calls the provider for English).
- Add `localizeCard(request: LocalizeRequest): Promise<LocalizedCard>` to the
  `LLMProvider` interface with a doc comment stating it is a single structured
  call (not a tool loop) that translates ONLY prose, preserving code/identifiers.
- `LocalizationStore`: `LocalizationKey { owner; repo; fingerprint; language:
  LanguageCode }`; `get(key): Promise<LocalizedCard | null>`; `save(key, value:
  LocalizedCard): Promise<void>`. Doc comment mirrors `FingerprintCache`.

**Patterns to follow:** `ports/llmProvider.ts` request interfaces;
`ports/fingerprintCache.ts` / `ports/deckStore.ts` for the store port shape +
doc comments.

**Test scenarios:** `Test expectation: none` for the port files (pure type
declarations). The fake updates are exercised by their existing suites — those
suites must still pass with no behavior change (the new `vi.fn()` is never called).

### U3. Core localization orchestration

**Goal:** The deterministic, fully-fakeable function that turns English cards into
localized cards: English passthrough, cache-first, provider-on-miss, English
fallback on error — touching only `explanation` + `suggestions`.

**Requirements:** AC "render in chosen language"; AC "produced via LLMProvider and
cached"; AC "code/identifiers/risk not altered"; AC "falls back to English."

**Dependencies:** U1, U2.

**Files:**
- `packages/core/src/localize/localizeCards.ts` (new)
- `packages/core/src/localize/localizeCards.test.ts` (new)
- `packages/core/src/index.ts` (export `localizeCards`, `LocalizePorts`,
  `LocalizeRef`)

**Approach:**
- `LocalizePorts { llm: Pick<LLMProvider,"localizeCard">; store: LocalizationStore }`
  and `LocalizeRef { owner: string; repo: string }`.
- `localizeCards(cards: readonly Card[], language: LanguageCode, ref: LocalizeRef,
  ports: LocalizePorts): Promise<Card[]>`:
  - `language === DEFAULT_LANGUAGE` → return `[...cards]` immediately, no I/O.
  - Otherwise map each card through `localizeOneCard` with **bounded concurrency**
    (mirror `resolveCardFileTexts`'s `Promise.all` over a capped set) and return
    in input order.
- `localizeOneCard(card, language, ref, ports)`:
  - `store.get({owner,repo,fingerprint:card.fingerprint,language})` →
    on hit, return `{ ...card, explanation: hit.explanation, suggestions:
    hit.suggestions }`.
  - on miss, `llm.localizeCard({ explanation: card.explanation, suggestions:
    card.suggestions, language })`; `store.save(key, localized)` (best-effort —
    a save failure still returns the freshly localized card); return
    `{ ...card, ...localized prose }`.
  - Any thrown error from `store.get` or `llm.localizeCard` → log + return the
    original (English) `card` unchanged. Per-card fallback, so one bad card never
    fails the whole deck.
  - Spread-from-`card` guarantees `fingerprint/file/tier/rank/riskScore/highlights`
    are structurally identical to the input — only the two prose fields change.

**Patterns to follow:** `verify/verifyFinding.ts` (pure port-orchestration shape,
injected `ports`, deterministic + fakeable); `lib/deck.ts` `resolveCardFileTexts`
for bounded concurrent mapping + per-item degrade.

**Test scenarios:**
- English passthrough: `language="en"` returns cards deep-equal to input; `llm`
  and `store` fakes are never called (assert call counts 0).
- Cache hit: `store.get` returns a `LocalizedCard`; result card's `explanation`/
  `suggestions` come from the cache; `llm.localizeCard` not called; all non-prose
  fields equal the input card.
- Cache miss → provider: `store.get` → `null`, `llm.localizeCard` returns
  localized prose; result uses it; `store.save` called once with the right key.
- Provider error → English fallback: `llm.localizeCard` rejects; result card
  equals the original English card; no throw escapes.
- Store-get error → fallback: `store.get` rejects; falls through to provider (or
  English) without throwing.
- Save error tolerated: `store.save` rejects but the localized card is still
  returned.
- Non-prose immutability (covers AC "code/identifiers/risk not altered"): for a
  card with `highlights`, `riskScore`, `tier`, `fingerprint`, assert every
  non-prose field is `===`/deep-equal to the input after localization.
- Order + per-card isolation: a 3-card deck where the middle card's provider call
  throws returns 3 cards in order, middle one English, outer two localized.

### U4. LLM adapter implements `localizeCard`

**Goal:** The Vercel-AI-SDK implementation of `localizeCard` — one structured call
that translates prose and preserves code, with a prompt that says so.

**Requirements:** AC "produced via the LLMProvider port" (the concrete adapter).

**Dependencies:** U1, U2.

**Files:**
- `packages/llm/src/index.ts` (add `LOCALIZE_SYSTEM_PROMPT`,
  `buildLocalizePrompt`, and the `localizeCard` method on the returned provider)
- `packages/llm/src/index.test.ts` (extend)

**Approach:**
- `LOCALIZE_SYSTEM_PROMPT`: "Translate the reviewer-facing prose into <language>.
  Translate ONLY natural language. Preserve verbatim: code, identifiers, symbols,
  file paths, type names, and risk terminology that is a proper noun. Keep the
  number and order of suggestions; do not add, drop, or merge them. Return the
  translated explanation and suggestions."
- `buildLocalizePrompt({ explanation, suggestions, language })`: emit the human
  language *name* (map the code → English name, e.g. `es → "Spanish"`) plus the
  source explanation and a numbered suggestions list.
- `localizeCard`: `generateText({ model: model(config.reviewModel), system,
  prompt, output: Output.object({ schema: LocalizedCardSchema }) })` → return
  `output`. Runs on the review-class model (cheap tier), no tools — matches
  `verifyFinding`/`detectScopeCreep`.

**Patterns to follow:** the existing `verifyFinding` block in
`packages/llm/src/index.ts` (single `generateText` + `Output.object`, review-class
model, doc comment); `buildVerifyPrompt` for the prompt builder shape.

**Test scenarios:**
- `buildLocalizePrompt` includes the target language name ("Spanish" for `"es"`),
  the explanation text, and every suggestion.
- `createReviewProvider({LLM_PROVIDER})` exposes `localizeCard` as a function for
  each of `anthropic`/`openai`/`google` (extend the existing per-vendor test).
- `LOCALIZE_SYSTEM_PROMPT` instructs preserving code/identifiers (assert it
  contains the preserve-verbatim instruction) — guards the AC against prompt drift.

### U5. `card_localizations` table — schema + migration + web mirror

**Goal:** The persistent cache the store reads/writes, defined once canonically in
`apps/app` and mirrored read/write in `apps/web`.

**Requirements:** AC "cached per card/language."

**Dependencies:** none (DB layer); consumed by U6.

**Files:**
- `apps/app/src/db/schema.ts` (add `cardLocalizations` table)
- `apps/app/src/db/migrations/0008_card_localizations.sql` (new)
- `apps/app/src/db/migrations/meta/_journal.json` (append idx 8 entry)
- `apps/web/lib/db.ts` (mirror `cardLocalizations`; add to the `schema` object)

**Approach:**
- Table `card_localizations`: `id serial pk`, `owner text`, `repo text`,
  `fingerprint text`, `language text`, `localized jsonb` (the `LocalizedCard`),
  `updated_at timestamptz default now()`. Unique
  `(owner, repo, fingerprint, language)`; index on `(owner, repo, fingerprint)`
  for the per-card lookup. Mirror the `fingerprints` table's structure + doc
  comment (it is the same keying + a jsonb payload re-validated on read).
- Migration SQL: `CREATE TABLE IF NOT EXISTS` + the unique constraint + index,
  matching the hand-written style of `0007_decks.sql`. Append the journal entry
  with `idx: 8`, `tag: "0008_card_localizations"`, a `when` strictly greater than
  idx 7's. Prefer `pnpm db:generate` to produce both; if drizzle-kit output drifts
  from the existing hand-written style, hand-write to match and keep the journal
  consistent.
- Web mirror: declare the same `pgTable` in `lib/db.ts` with the lockstep doc
  comment (as `decks`/`web_sessions` do) and add it to the `schema` map.

**Patterns to follow:** `apps/app/src/db/schema.ts` `fingerprints` (keying) and
`decks` (jsonb payload); `0007_decks.sql` migration style; `apps/web/lib/db.ts`
`decks` mirror + lockstep comment.

**Test scenarios:** `Test expectation: none -- schema/migration/DDL; exercised
end-to-end by U6's store and the CI `db:migrate` step.` The CI migrate step
applying cleanly against fresh Postgres is the verification.

### U6. Web localization store + provider wiring

**Goal:** The `apps/web` glue: a `LocalizationStore` over the mirrored table, the
lazily-constructed `LLMProvider`, and a `localizeDeckCards` wrapper that calls the
core orchestration and degrades the whole deck to English on any top-level failure.

**Requirements:** AC "produced via LLMProvider … cached"; AC "falls back to
English."

**Dependencies:** U3, U4, U5; KTD6 (`@diffsense/llm` dep).

**Files:**
- `apps/web/package.json` (add `"@diffsense/llm": "workspace:*"`)
- `apps/web/next.config.mjs` (add `@diffsense/llm` to `transpilePackages`)
- `apps/web/lib/localize.ts` (new)
- `apps/web/lib/localize.test.ts` (new)

**Approach:**
- `webLocalizationStore(): LocalizationStore` over `getDb()` + `cardLocalizations`:
  `get` selects by the 4-tuple and re-validates `localized` against
  `LocalizedCardSchema` (return `null` on miss or parse failure — never throw a
  bad row into the render); `save` upserts on the unique key
  (`onConflictDoUpdate` setting `localized` + `updated_at`).
- `getReviewProvider()`: lazy singleton `createReviewProvider()` from
  `@diffsense/llm`. Construction wrapped so a config error (bad `LLM_PROVIDER`)
  surfaces as "localization unavailable," never a 500.
- `localizeDeckCards(cards, language, ref, ports = defaults)`:
  `try { return await localizeCards(cards, language, ref, ports) } catch (err) {
  console.error(...); return [...cards] }`. The optional `ports` arg keeps this
  unit-testable without a DB or network (inject fakes), matching how `lib/deck.ts`
  helpers are tested in isolation.

**Patterns to follow:** `apps/web/lib/deck.ts` (direct Drizzle read/write +
re-validation + degrade-don't-throw); `apps/app/src/adapters/fingerprintCache.ts`
for the upsert store shape; `apps/web/lib/findings.ts` for the lean lib module.

**Test scenarios:**
- English passthrough: `localizeDeckCards(cards, "en", ref, fakePorts)` returns the
  input cards; fake `llm`/`store` untouched.
- Localized path: fake store miss + fake `llm` returning prose → result cards carry
  translated prose; `store.save` invoked.
- Top-level fallback: a `ports` whose `store.get` and `llm.localizeCard` both throw
  → returns English cards, no throw.
- (Store mapping) a `webLocalizationStore` `get` over a fake/stub db returning a
  malformed `localized` JSON → `null` (no throw). Keep DB-touching assertions to
  the pure mapping; the live query is covered by the deck page at runtime.

### U7. Language picker + deck page localization

**Goal:** Wire it to the surface — a language selector the reviewer uses, the
cookie that records it, and the deck page localizing cards before render.

**Requirements:** AC "user can select a spoken language"; AC "explanations and
suggestions render in the chosen language."

**Dependencies:** U1 (language helpers), U6 (`localizeDeckCards`).

**Files:**
- `apps/web/lib/language.ts` (new — cookie name + `resolveLanguageCookie`)
- `apps/web/lib/language.test.ts` (new)
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/actions.ts` (add `setLanguage`)
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/LanguagePicker.tsx` (new)
- `apps/web/app/pr/[owner]/[repo]/[number]/deck/page.tsx` (read cookie, localize,
  render picker)

**Approach:**
- `lib/language.ts`: `LANGUAGE_COOKIE = "df_lang"`;
  `resolveLanguageCookie(value): LanguageCode` delegating to core `resolveLanguage`
  (thin, but gives the cookie name + resolution one tested home).
- `setLanguage(formData)` server action: read `lang`, validate via
  `isSupportedLanguage` (ignore/keep-English on bad input), `cookies().set` the
  cookie (1-year maxAge, `httpOnly:false` is unnecessary — keep default
  `httpOnly`/`sameSite:"lax"`), then `revalidatePath` the deck route so the server
  re-renders in the new language. Re-check session like `recordSwipe` does.
- `LanguagePicker.tsx` (server component): a `<form action={setLanguage}>` with a
  `<select name="lang" defaultValue={current}>` built from `SUPPORTED_LANGUAGES`
  and a submit button — no client JS required, accessible, mobile-first. Hidden
  fields carry `owner`/`repo`/`prNumber` for `revalidatePath`.
- `page.tsx`: `const language = resolveLanguageCookie((await cookies()).get(
  LANGUAGE_COOKIE)?.value)`. When a deck exists, compute
  `const localized = await localizeDeckCards(deck.cards, language, {owner, repo})`
  and pass `localized` into `buildCardViews` (replacing `deck.cards`). Render
  `<LanguagePicker current={language} .../>` in the header. The `force-dynamic`
  export already present means the cookie is read per request.

**Patterns to follow:** `deck/actions.ts` `recordSwipe` (server action, session
re-check, input validation); `deck/page.tsx` existing structure;
`app/logout/route.ts` / session code for `cookies()` usage; `SignOutButton.tsx`
for a small form-driven control.

**Execution note:** Start `lib/language.ts` test-first — the cookie→language
resolution + fallback is the unit with the clearest contract.

**Test scenarios:**
- `resolveLanguageCookie("de")` → `"de"`; `resolveLanguageCookie(undefined)` /
  `"zz"` → `"en"`.
- `LANGUAGE_COOKIE` is the expected stable string.
- (Picker render is trivial JSX; covered by the page rendering in CI typecheck/
  build — no dedicated DOM test required, but a render-smoke test may be added if
  cheap.) `Test expectation: page/picker wiring proven by build + the language.ts
  unit; behavior of localization itself is covered in U3/U6.`

---

## System-Wide Impact

- **New env reach:** the `web` container now consumes `LLM_PROVIDER` /
  `REVIEW_MODEL` / provider API key (it constructs an `LLMProvider`). Already in
  `.env`/`.env.example` for `apps/app`; the same compose `.env` feeds `web`. Add a
  one-line note to `.env.example` that `web` reads these for card localization.
  Absence degrades to English (graceful), so it is not a hard requirement to boot.
- **Interface change blast radius:** adding `localizeCard` to `LLMProvider` forces
  every implementer + fake to provide it. Only `packages/llm` implements it for
  real; the 7 test fakes (U2) get a `vi.fn()`. No production code outside
  `packages/llm` implements `LLMProvider`.
- **DB migration:** `0008_card_localizations` runs in the CI `db:migrate` step and
  on deploy (one-shot migrate). Additive, no backfill, no change to existing rows.
- **Provider independence preserved:** localization is config-driven via the same
  port; switching Anthropic→OpenAI→Gemini needs no `core`/`web` code change.

---

## Risks & Mitigations

- **Render latency on first load in a new language** (N uncached provider calls in
  the server render). Mitigated by: cache (subsequent loads instant), bounded
  concurrency, and the English default path being inference-free. Streaming is
  deferred. Acceptable for the slice.
- **Cache staleness** if the English source text changes for an unchanged
  fingerprint. Same accepted limitation as the fingerprint review cache; documented
  as out-of-scope. Key includes `fingerprint`, so structural changes miss naturally.
- **`@diffsense/llm` pulled into the Next build** could surprise the bundler.
  Mitigation: it is used only in server components / server actions / lib (never
  client); add to `transpilePackages`; the swipe UI stays a client island that
  imports only plain `CardView` data.
- **Biome lint + per-package typecheck** must stay green: the fake updates (U2) and
  the new web dep are the likeliest break points; the CI replicates locally
  (lint → typecheck → migrate → test).

---

## Requirements Traceability

| Acceptance criterion | Units |
|---|---|
| User can select a spoken language | U1 (set), U7 (picker + cookie + action) |
| Explanations & suggestions render in chosen language | U3, U6, U7 |
| Localized prose produced via `LLMProvider` port, cached per card/language | U2, U3, U4, U5, U6 |
| Code, identifiers, risk scores not altered | U1 (prose-only schema), U3 (spread-from-card + immutability test), U4 (preserve-verbatim prompt) |
| Falls back gracefully to English if unavailable | U3 (per-card), U6 (top-level), U1 (`resolveLanguage`) |

---

## Verification

- `pnpm lint && pnpm typecheck && pnpm db:migrate && pnpm test` all green locally
  (mirrors CI exactly).
- New core suites (U1/U3) prove English passthrough, cache hit/miss, provider
  fallback, and non-prose immutability with fakes — no network, no DB.
- Migration applies clean against fresh Postgres (CI `db:migrate`).
- Manual: open a deck, pick a non-English language, confirm explanation +
  suggestions translate while code window, file path, tier, and risk score are
  unchanged; re-open and confirm no second inference (cache hit); unset the
  provider key and confirm English still renders.
