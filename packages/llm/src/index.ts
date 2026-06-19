/**
 * Stub for the provider-agnostic LLM adapter.
 *
 * The real implementation (introduced in issue #8) will implement the
 * `LLMProvider` port defined in `@diffsense/core` using the Vercel AI SDK,
 * selecting provider + model from env (LLM_PROVIDER / REVIEW_MODEL /
 * SYNTHESIS_MODEL). It imports no vendor SDK yet — this slice ships no LLM code.
 *
 * See docs/STACK.md "LLM provider independence" and docs/ARCHITECTURE.md §1.
 */

export const LLM_ADAPTER_PLACEHOLDER = "diffsense-llm-adapter-stub" as const;
