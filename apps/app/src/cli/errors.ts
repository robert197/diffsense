/**
 * Tagged error classes the CLI maps to distinct exit codes (issue #32, KTD4).
 * Keeping them as classes (rather than string codes) lets `exitCodeForError`
 * classify failures exactly via `instanceof`, so usage, config, and runtime
 * failures stay distinguishable to a calling agent.
 */

/** Bad invocation — unparseable `<pr-ref>`, missing subcommand. Exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Missing or invalid env/flag configuration (creds, DATABASE_URL). Exit code 3. */
export class CliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliConfigError";
  }
}
