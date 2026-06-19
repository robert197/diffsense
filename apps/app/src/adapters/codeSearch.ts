import { Lang, parse } from "@ast-grep/napi";
import type { CodeReference, CodeSearch } from "@diffsense/core";

/**
 * ast-grep adapter implementing the `CodeSearch` port (docs/ARCHITECTURE.md §3) —
 * the blast-radius tool. `core` owns the port; this is the only place that knows
 * it is ast-grep.
 *
 * It operates over an injected set of `{ path, source }` files (the worker in #8
 * supplies them from the PR / repo tree), so it is bounded by construction and
 * testable without a checkout. It is deliberately forgiving: every parse + match
 * is wrapped, so an unresolved symbol or an unparseable file yields an empty
 * list, never an error (issue #7, R3).
 *
 * Language coverage is the JS/TS family that `@ast-grep/napi` bundles natively
 * (ts, tsx, js, jsx). Other extensions degrade to empty results; adding them is
 * a matter of registering an `@ast-grep/lang-*` pack, not a code change here.
 */

export interface CodeFile {
  path: string;
  source: string;
}

export interface CodeSearchOptions {
  files: CodeFile[];
  /** Cap on total returned references across all files. Default 50. */
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 50;

/** Map a file extension to an ast-grep language; null skips the file. */
function langForPath(path: string): Lang | null {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".ts":
      return Lang.TypeScript;
    case ".tsx":
    case ".jsx":
      return Lang.Tsx;
    case ".js":
    case ".cjs":
    case ".mjs":
      return Lang.JavaScript;
    default:
      return null;
  }
}

/** Definition-pattern templates for the JS/TS family. `name` is substituted. */
function definitionPatterns(name: string): string[] {
  return [
    `function ${name}($$$A) { $$$B }`,
    `const ${name} = $$$A`,
    `let ${name} = $$$A`,
    `class ${name} { $$$B }`,
    `class ${name} extends $$$P { $$$B }`,
  ];
}

/** Run one pattern against one parsed file, collecting refs. Never throws. */
function matchPattern(path: string, lang: Lang, source: string, pattern: string): CodeReference[] {
  try {
    const root = parse(lang, source).root();
    return root.findAll(pattern).map((node) => ({
      path,
      // ast-grep rows are 0-based; CodeReference lines are 1-based.
      line: node.range().start.line + 1,
      text: node.text().trimEnd(),
    }));
  } catch {
    // Unparseable source or pattern for this language — contribute nothing.
    return [];
  }
}

function dedupe(refs: CodeReference[]): CodeReference[] {
  const seen = new Set<string>();
  const out: CodeReference[] = [];
  for (const ref of refs) {
    const key = `${ref.path}:${ref.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

export function createAstGrepCodeSearch(options: CodeSearchOptions): CodeSearch {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

  function search(patterns: string[]): CodeReference[] {
    const results: CodeReference[] = [];
    for (const file of options.files) {
      const lang = langForPath(file.path);
      if (lang === null) {
        continue;
      }
      for (const pattern of patterns) {
        for (const ref of matchPattern(file.path, lang, file.source, pattern)) {
          results.push(ref);
          if (results.length >= maxResults) {
            return dedupe(results).slice(0, maxResults);
          }
        }
      }
    }
    return dedupe(results).slice(0, maxResults);
  }

  return {
    async findCallSites(symbol: string): Promise<CodeReference[]> {
      if (symbol.trim() === "") {
        return [];
      }
      return search([`${symbol}($$$ARGS)`]);
    },
    async findSymbol(name: string): Promise<CodeReference[]> {
      if (name.trim() === "") {
        return [];
      }
      return search(definitionPatterns(name));
    },
  };
}
