import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  ChunkReviewSchema,
  type LLMProvider,
  type LocalizeRequest,
  LocalizedCardSchema,
  PortfolioSchema,
  type ReviewChunk,
  type ReviewRequest,
  ScopeCreepReportSchema,
  type ScopeRequest,
  type SynthesisRequest,
  VerificationVerdictSchema,
  type VerifyRequest,
  languageName,
} from "@diffsense/core";
import { type LanguageModel, Output, generateText, stepCountIs, tool } from "ai";

/**
 * The provider-agnostic LLM adapter (issue #8, docs/STACK.md "LLM provider
 * independence"). It implements the `LLMProvider` port from `@diffsense/core`
 * with the Vercel AI SDK: one `generateText` path, the provider + model chosen
 * from env. `core` never imports a vendor SDK — switching Anthropic→OpenAI→Gemini
 * is a config change here, no recompile of `core`.
 */

export type SupportedProvider = "anthropic" | "openai" | "google";

/** Defaults from docs/STACK.md — Anthropic, opus for review, fable for synthesis. */
export const DEFAULT_PROVIDER: SupportedProvider = "anthropic";
export const DEFAULT_REVIEW_MODEL = "claude-opus-4-8";
export const DEFAULT_SYNTHESIS_MODEL = "claude-fable-5";

/** Bounded tool budget for the agentic review unit — never runs away (§3). */
export const REVIEW_STEP_BUDGET = 8;

/**
 * Wall-clock cap on a single `localizeCard` call (issue #28). Localization runs at
 * read time inside the deck's server render, so a slow or hung provider must not
 * stall the page: on timeout the call aborts and `localizeCards` degrades that card
 * to English (its per-card fallback). Override with `LOCALIZE_TIMEOUT_MS`.
 */
export const DEFAULT_LOCALIZE_TIMEOUT_MS = 30_000;

export interface ModelConfig {
  provider: SupportedProvider;
  /** Model id for the `review` tier (`REVIEW_MODEL`). */
  reviewModel: string;
  /** Model id for the `synthesis` (top-risk) tier (`SYNTHESIS_MODEL`). */
  synthesisModel: string;
}

/**
 * Resolve provider + model ids from env. Fails fast on an unsupported provider so
 * a typo never silently falls back to the wrong vendor. `REVIEW_MODEL` /
 * `SYNTHESIS_MODEL` default to the Anthropic models; set them when using another
 * provider.
 */
export function resolveModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const provider = (env.LLM_PROVIDER ?? DEFAULT_PROVIDER).toLowerCase();
  if (provider !== "anthropic" && provider !== "openai" && provider !== "google") {
    throw new Error(
      `Unsupported LLM_PROVIDER "${provider}" (expected "anthropic", "openai", or "google")`,
    );
  }
  return {
    provider,
    reviewModel: env.REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL,
    synthesisModel: env.SYNTHESIS_MODEL ?? DEFAULT_SYNTHESIS_MODEL,
  };
}

/** Build the AI SDK provider factory for the configured vendor. */
function selectProvider(
  config: ModelConfig,
  env: NodeJS.ProcessEnv,
): (modelId: string) => LanguageModel {
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    case "openai":
      return createOpenAI({ apiKey: env.OPENAI_API_KEY });
    case "google":
      return createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  }
}

/** System prompt: what a good review is (prompt-defined behavior, §3). */
export const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer examining one changed chunk of a pull request.

Pull exactly the context you need with the provided tools, the way a senior reviewer follows a thread:
- read_file to see the enclosing function or neighbouring code,
- find_call_sites to gauge the blast radius of a changed symbol,
- get_pr_intent to learn what the author says the change is for,
- read_conventions to respect this repo's learned norms.
A trivial change needs no tools; a signature change usually needs its call sites. Do not over-fetch.

Then produce a structured review:
- explanation: plain language, what this change does.
- claims: falsifiable statements about behaviour or risk, each tied to concrete evidence (a path:line, a symbol, or a quoted snippet). Only include claims a reviewer could check or refute. None is fine for a trivial change.
- rating: high, medium, or low risk.
- reasons: the named reasons behind the rating.

Be specific and grounded. Never invent code you have not read.`;

/** The per-chunk user prompt — the change under review. */
export function buildReviewPrompt(chunk: ReviewChunk): string {
  return [
    `File: ${chunk.file}`,
    `Structural risk tier: ${chunk.tier}`,
    "",
    "Diff hunk under review:",
    "```diff",
    chunk.patch,
    "```",
  ].join("\n");
}

/**
 * Second-phase prompt for providers that can't combine tools with a JSON response
 * schema in one call (Google): the tool loop already inspected the change and wrote
 * the review as prose; this tool-free call coerces that prose into the ChunkReview
 * schema. Providers that accept tools + structured output together never use it.
 */
export function buildStructuredReviewPrompt(chunk: ReviewChunk, review: string): string {
  return [
    buildReviewPrompt(chunk),
    "",
    "Your review notes from inspecting the change with the tools:",
    review.trim() ? review : "(no additional notes — base the review on the diff above)",
    "",
    "Now return the structured review for this change.",
  ].join("\n");
}

/** System prompt: the adversarial verifier, prompted to refute (issue #9, §3). */
export const VERIFY_SYSTEM_PROMPT = `You are an independent verifier. A first reviewer flagged a risk in one changed chunk of a pull request. Your job is to refute it.

Argue, from the diff and the finding's own evidence, why the risk does not actually hold — for example the value is guarded upstream, the path is unreachable, the claim misreads the code, or the change is safe in context. A reviewer disengages from a tool that cries wolf, so a finding only survives if it withstands a genuine attempt to break it.

Return:
- refuted: true if the finding does not hold up (the refutation succeeds), false if the risk is real and survives the challenge.
- rationale: the refutation argument when refuted; when the finding survives, why the challenge fails.

Be skeptical but honest. Do not refute a real bug just to dismiss it; do not uphold a finding the diff clearly disproves.`;

/** The per-finding user prompt — the finding to challenge plus its diff context. */
export function buildVerifyPrompt({ review, chunk }: VerifyRequest): string {
  const claims = review.claims.length
    ? review.claims.map((c, i) => `${i + 1}. ${c.claim}\n   evidence: ${c.evidence}`).join("\n")
    : "(none)";
  return [
    `File: ${chunk.file}`,
    `Structural risk tier: ${chunk.tier}`,
    `Finding rating: ${review.rating}`,
    "",
    `Finding: ${review.explanation}`,
    "",
    "Claims to refute:",
    claims,
    "",
    "Stated reasons:",
    ...review.reasons.map((r) => `- ${r}`),
    "",
    "Diff hunk the finding is about:",
    "```diff",
    chunk.patch,
    "```",
  ].join("\n");
}

/** System prompt: map the diff to declared intent, flag the unmapped (issue #10). */
export const SCOPE_SYSTEM_PROMPT = `You are checking a pull request for scope creep. The author declared what the PR is for; your job is to find changes that match none of that declared intent.

First, read the PR title and description and list the distinct intents the author declared (for example "add rate limiting", "fix the login redirect"). Then walk the diff and map each changed region to a declared intent.

A region is scope creep only when it serves none of the declared intents. Be precise — reviewers disengage from a tool that cries wolf:
- Supporting edits that the declared work genuinely needs are in scope: new imports, types, tests, config, or call sites for the declared feature.
- An incidental edit in an unrelated file or subsystem that no declared intent calls for is scope creep — these undeclared, drive-by changes are the highest-risk content in the PR.

Return:
- declaredIntents: the distinct intents you read from the title + description.
- findings: one entry per changed region that matches no declared intent. Use the bare repo-relative file path (no \`a/\` or \`b/\` prefix), a plain-language summary of what the out-of-scope edit does, and the rationale for why it serves none of the declared intents. Return an empty list when every change maps to a declared intent.`;

/** The per-PR user prompt — the declared intent plus the full diff to map. */
export function buildScopePrompt({ diff, intent }: ScopeRequest): string {
  return [
    "PR title:",
    intent.title,
    "",
    "PR description:",
    intent.body.trim() ? intent.body : "(none)",
    "",
    "Full diff:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/** System prompt: PR-level portfolio synthesis (issue #11, §3). */
export const SYNTHESIS_SYSTEM_PROMPT = `You are a senior reviewer writing the PR-level summary. The per-chunk findings you are given already survived an independent verification pass — treat them as real risks, not noise.

Roll them up the way a senior reviewer hands off a review:
- Group related findings into named risk positions, counting what each covers (for example "2 unverified API-boundary changes", "1 undeclared data-model edit"). One finding can be its own position.
- Each position must link back to the chunks it came from — cite them by the exact chunk reference(s) you were given. Never invent a reference.
- Give each position a categorical severity: high, medium, or low.
- Fold the scope-creep assessment in: an out-of-intent change is a risk position too, and it shapes the intent-coverage summary.

Then produce:
- positions: the named, chunk-linked risk positions (empty only if there is genuinely nothing to flag).
- intentCoverage: a short summary of how well the change matches its stated intent — on scope, over scope (does more than declared), or under scope.
- overview: a senior-reviewer-style paragraph on the PR's risk surface and what to look at first.

Do NOT produce a single overall numeric score. The named positions and the summaries are the glanceable result. Be specific and grounded in the findings you were given.`;

/** The synthesis user prompt — the verified findings, scope assessment, intent. */
export function buildSynthesisPrompt({ findings, scope, intent }: SynthesisRequest): string {
  const findingBlocks = findings.length
    ? findings.map((finding, i) => {
        const claims = finding.review.claims.length
          ? finding.review.claims
              .map((c) => `     - ${c.claim} (evidence: ${c.evidence})`)
              .join("\n")
          : "     - (none)";
        return [
          `${i + 1}. chunk ref: ${finding.chunkRef}  [${finding.rating}]`,
          `   file: ${finding.file}`,
          `   finding: ${finding.review.explanation}`,
          "   claims:",
          claims,
        ].join("\n");
      })
    : ["(none survived verification)"];

  const scopeBlock = scope.findings.length
    ? scope.findings
        .map(
          (finding, i) => `${i + 1}. ${finding.description} — files: ${finding.files.join(", ")}`,
        )
        .join("\n")
    : `(none — the diff stays within its stated intent: ${scope.withinIntent})`;

  return [
    "PR intent (what the author says the change is for):",
    `  title: ${intent.title}`,
    `  body: ${intent.body || "(empty)"}`,
    "",
    "Verified findings (link positions back using these chunk refs):",
    ...findingBlocks,
    "",
    "Scope-creep assessment (whole diff vs intent):",
    scopeBlock,
  ].join("\n");
}

/**
 * System prompt: translate a card's prose into the reviewer's language without
 * touching code (issue #28, §3). Localization widens who can review effectively;
 * it must never alter the code, identifiers, or risk signal — only the natural
 * language. A single structured call, like verify and scope-creep.
 */
export const LOCALIZE_SYSTEM_PROMPT = `You are translating a code-review card's reviewer-facing prose into another spoken language.

Translate ONLY the natural language. Preserve verbatim, untranslated:
- code, identifiers, symbols, function and type names,
- file paths and code locations (for example src/auth.ts:12),
- inline code spans and quoted snippets.

Keep the meaning exact and the tone plain — this is a senior reviewer explaining a change, not marketing copy. Keep the suggestions as a list with the same number of items in the same order; do not add, drop, merge, or reorder them.

Return:
- explanation: the explanation translated into the target language.
- suggestions: each suggestion translated into the target language, same count and order.`;

/** The per-card user prompt — the target language plus the English prose to translate. */
export function buildLocalizePrompt({
  explanation,
  suggestions,
  language,
}: LocalizeRequest): string {
  const suggestionList = suggestions.length
    ? suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "(none)";
  return [
    `Target language: ${languageName(language)}`,
    "",
    "Explanation to translate:",
    explanation,
    "",
    "Suggestions to translate (keep the count and order):",
    suggestionList,
  ].join("\n");
}

/**
 * Construct the `LLMProvider`. Provider + models come from env; each
 * `reviewChunk` call routes to the model class the deterministic shell chose,
 * runs the bounded tool loop, and returns a Zod-validated `ChunkReview`.
 * `verifyFinding`, `detectScopeCreep`, and `synthesize` are single structured
 * calls (no tool loop, §3) returning a Zod-validated `VerificationVerdict` /
 * `ScopeCreepReport` / `Portfolio`.
 */
export function createReviewProvider(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const config = resolveModelConfig(env);
  const model = selectProvider(config, env);
  const localizeTimeoutMs = Number(env.LOCALIZE_TIMEOUT_MS) || DEFAULT_LOCALIZE_TIMEOUT_MS;

  return {
    async reviewChunk(request: ReviewRequest) {
      const modelId =
        request.modelClass === "synthesis" ? config.synthesisModel : config.reviewModel;

      const tools = Object.fromEntries(
        request.tools.map((reviewTool) => [
          reviewTool.name,
          tool({
            description: reviewTool.description,
            inputSchema: reviewTool.inputSchema,
            execute: (input) => reviewTool.execute(input),
          }),
        ]),
      );

      // Google's API rejects function-calling combined with a JSON response schema
      // in one request ("Function calling with a response mime type
      // 'application/json' is unsupported"). Split the two for Google: run the
      // bounded tool loop to gather context as prose, then a second tool-free
      // structured call coerces that prose into a ChunkReview. Anthropic and OpenAI
      // accept tools + structured output in one call, so they keep the single
      // round-trip (no extra latency or cost for them).
      if (config.provider === "google") {
        const { text } = await generateText({
          model: model(modelId),
          system: REVIEW_SYSTEM_PROMPT,
          prompt: buildReviewPrompt(request.chunk),
          tools,
          stopWhen: stepCountIs(REVIEW_STEP_BUDGET),
        });
        const { output } = await generateText({
          model: model(modelId),
          system: REVIEW_SYSTEM_PROMPT,
          prompt: buildStructuredReviewPrompt(request.chunk, text),
          output: Output.object({ schema: ChunkReviewSchema }),
        });
        return output;
      }

      const { output } = await generateText({
        model: model(modelId),
        system: REVIEW_SYSTEM_PROMPT,
        prompt: buildReviewPrompt(request.chunk),
        tools,
        stopWhen: stepCountIs(REVIEW_STEP_BUDGET),
        output: Output.object({ schema: ChunkReviewSchema }),
      });

      return output;
    },

    async localizeCard(request: LocalizeRequest) {
      const { output } = await generateText({
        // Localization is a single structured call over the prose already in hand
        // (§3): no tools, no loop. Runs on the review-class model to keep the
        // translation pass cost-bounded, and the prompt preserves code verbatim so
        // only natural language changes (issue #28). A timeout bounds the call so a
        // hung provider can't stall the deck's server render — on abort the card
        // degrades to English via localizeCards' per-card fallback.
        model: model(config.reviewModel),
        system: LOCALIZE_SYSTEM_PROMPT,
        prompt: buildLocalizePrompt(request),
        output: Output.object({ schema: LocalizedCardSchema }),
        abortSignal: AbortSignal.timeout(localizeTimeoutMs),
      });

      return output;
    },

    async verifyFinding(request: VerifyRequest) {
      const { output } = await generateText({
        // Verify runs on the review-class model: independence comes from the
        // refutation prompt and a separate call, not a stronger tier, and the
        // context is already in hand (§3). Keeps the precision pass cost-bounded.
        model: model(config.reviewModel),
        system: VERIFY_SYSTEM_PROMPT,
        prompt: buildVerifyPrompt(request),
        output: Output.object({ schema: VerificationVerdictSchema }),
      });

      return output;
    },

    async detectScopeCreep(request: ScopeRequest) {
      const { output } = await generateText({
        // Scope-creep is a single structured call over the whole diff + intent
        // (§3): the inputs are already in hand, so no tool loop. Runs on the
        // review-class model to keep the pass cost-bounded.
        model: model(config.reviewModel),
        system: SCOPE_SYSTEM_PROMPT,
        prompt: buildScopePrompt(request),
        output: Output.object({ schema: ScopeCreepReportSchema }),
      });

      return output;
    },

    async synthesize(request: SynthesisRequest) {
      const { output } = await generateText({
        // Synthesis runs on the synthesis-class model (claude-fable-5 by
        // default): the top-risk roll-up earns the stronger tier. A single
        // structured call — the verified findings + scope + intent are in hand,
        // nothing to explore (§3).
        model: model(config.synthesisModel),
        system: SYNTHESIS_SYSTEM_PROMPT,
        prompt: buildSynthesisPrompt(request),
        output: Output.object({ schema: PortfolioSchema }),
      });

      return output;
    },
  };
}
