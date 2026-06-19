import { z } from "zod";
import type { CodeReference, CodeSearch } from "../ports/codeSearch.js";
import type { ConventionStore, RepoRef } from "../ports/conventionStore.js";
import type { PrIntent, RepoReader } from "../ports/repoReader.js";

/**
 * The context tools the agentic review unit (#8) calls on demand
 * (docs/ARCHITECTURE.md §3). These are *primitives, not a workflow*: the tools
 * fetch context; the review prompt decides which to call per chunk.
 *
 * `core` cannot import the AI SDK (non-negotiable rule), so a tool is a plain
 * descriptor — a name, an LLM-facing description, a Zod input schema (the shared
 * contract across providers), and an `execute` that delegates to a port. The
 * `packages/llm` adapter in #8 maps each `ReviewTool` to an AI SDK `tool()`; the
 * Zod schema is already the validation source, so no translation layer is needed.
 */
export interface ReviewTool<I, O> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  execute: (input: I) => Promise<O>;
}

/**
 * A `ReviewTool` with its input/output types erased, for passing a mixed list
 * across the `LLMProvider` boundary (the review unit hands the model whatever
 * tools it was wired with). `execute` is a *method* so the concrete tuple from
 * `createReviewTools` stays assignable; `packages/llm` re-derives the precise
 * input type from `inputSchema` when it maps each one to an AI SDK `tool()`.
 */
export interface AnyReviewTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute(input: unknown): Promise<unknown>;
}

/** Input schemas, exported so the #8 llm adapter can reuse them verbatim. */
export const ReadFileInput = z.object({
  path: z.string().min(1),
  range: z
    .object({ start: z.number().int().positive(), end: z.number().int().positive() })
    .optional(),
});
export type ReadFileInput = z.infer<typeof ReadFileInput>;

export const FindCallSitesInput = z.object({ symbol: z.string().min(1) });
export type FindCallSitesInput = z.infer<typeof FindCallSitesInput>;

/** `get_pr_intent` and `read_conventions` take no arguments. */
export const NoInput = z.object({});
export type NoInput = z.infer<typeof NoInput>;

/** The ports + repo coordinates the tool layer is wired to. */
export interface ReviewToolPorts {
  repoReader: RepoReader;
  codeSearch: CodeSearch;
  conventionStore: ConventionStore;
  /** The repo whose conventions `read_conventions` returns. */
  repo: RepoRef;
}

/**
 * Build the four context tools bound to concrete ports. Pure: no I/O of its own,
 * just wiring. Returns them in a stable order so #8 (and tests) can rely on it.
 */
export function createReviewTools(
  ports: ReviewToolPorts,
): [
  ReviewTool<ReadFileInput, string | null>,
  ReviewTool<FindCallSitesInput, CodeReference[]>,
  ReviewTool<NoInput, PrIntent>,
  ReviewTool<NoInput, string | null>,
] {
  const { repoReader, codeSearch, conventionStore, repo } = ports;
  return [
    {
      name: "read_file",
      description:
        "Read a file from the PR's head, or just a line range. Use it to pull the enclosing function or neighbouring code. Returns null if the file does not exist.",
      inputSchema: ReadFileInput,
      execute: ({ path, range }) => repoReader.readFile(path, range),
    },
    {
      name: "find_call_sites",
      description:
        "Find where a symbol is called across the repo — the blast radius of a signature change. Returns an empty list when nothing matches.",
      inputSchema: FindCallSitesInput,
      execute: ({ symbol }) => codeSearch.findCallSites(symbol),
    },
    {
      name: "get_pr_intent",
      description: "Get the PR title and description — what the author says the change is for.",
      inputSchema: NoInput,
      execute: () => repoReader.getPrIntent(),
    },
    {
      name: "read_conventions",
      description:
        "Read the learned conventions for this repo (accumulated review norms). Returns null when none have been recorded yet.",
      inputSchema: NoInput,
      execute: () => conventionStore.readConventions(repo),
    },
  ];
}
