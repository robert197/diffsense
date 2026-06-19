import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  ChunkReviewSchema,
  type LLMProvider,
  type ReviewChunk,
  type ReviewRequest,
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
 * Construct the `LLMProvider`. Provider + models come from env; each
 * `reviewChunk` call routes to the model class the deterministic shell chose,
 * runs the bounded tool loop, and returns a Zod-validated `ChunkReview`.
 */
export function createReviewProvider(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const config = resolveModelConfig(env);
  const model = selectProvider(config, env);

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
  };
}
