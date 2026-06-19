import parseDiff from "parse-diff";
import type { LLMProvider } from "../ports/llmProvider.js";
import type { PrIntent } from "../ports/repoReader.js";
import type { ScopeFinding } from "../schemas/scopeCreep.js";

/**
 * The intent / scope-creep pass (issue #10, docs/ARCHITECTURE.md §2–§3). Pure
 * orchestration: the deterministic shell decides *when* to ask and guards the
 * output; the judgment — which regions match which declared intent — stays inside
 * `LLMProvider.detectScopeCreep`, a single structured call (the diff + intent are
 * already in hand, so no tool loop, §3).
 *
 * Undeclared, drive-by changes are the highest-risk content in AI-generated PRs
 * and no competitor isolates them (STRATEGY.md). This surfaces them as a distinct
 * finding class.
 *
 * Deterministic and fully unit-testable with a fake `LLMProvider` (no network).
 */

export interface ScopeCreepPorts {
  llm: LLMProvider;
}

/** The file paths the diff actually touches (excluding /dev/null adds/deletes). */
function changedFiles(diff: string): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of parseDiff(diff)) {
    for (const path of [file.to, file.from]) {
      if (path && path !== "/dev/null") {
        paths.add(path);
      }
    }
  }
  return paths;
}

/**
 * Map the diff against the PR's declared intent and return the regions that match
 * no declared intent as scope-creep findings. An empty diff never reaches the LLM
 * (cost guard). A finding must point at a file the diff actually changes — the
 * deterministic shell drops any region the agent invented, so a hallucinated path
 * never becomes a surfaced finding.
 */
export async function detectScopeCreep(
  diff: string,
  intent: PrIntent,
  ports: ScopeCreepPorts,
): Promise<ScopeFinding[]> {
  const touched = changedFiles(diff);
  if (touched.size === 0) {
    return [];
  }
  const report = await ports.llm.detectScopeCreep({ diff, intent });
  return report.findings.filter((finding) => touched.has(finding.file));
}
