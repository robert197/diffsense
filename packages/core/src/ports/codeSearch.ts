/**
 * Port: structural code search for blast radius (docs/ARCHITECTURE.md §3).
 *
 * Pure interface — `core` never knows it is ast-grep. The search adapter in
 * `apps/app` implements it over the PR's candidate files. It is bounded and
 * forgiving: an unresolved symbol yields an empty list, never an error, so the
 * review unit can probe freely without a try/catch around every call.
 */

/** A single location a symbol is called or defined. */
export interface CodeReference {
  path: string;
  /** 1-based line number of the match. */
  line: number;
  /** The matched source text (trimmed of trailing whitespace). */
  text: string;
}

export interface CodeSearch {
  /** Call sites of `symbol` across the searched files. Empty when none match. */
  findCallSites(symbol: string): Promise<CodeReference[]>;
  /** Definition sites of `name` (function/const/class). Empty when none match. */
  findSymbol(name: string): Promise<CodeReference[]>;
}
