import { ArrowRight, GitPullRequest } from "lucide-react";
import type { PullRequest } from "../../lib/github";
import { relativeTime } from "../../lib/ui";
import { Badge } from "../ui/badge";

/**
 * A tappable open-PR row → its review entry point. Shared by the PR list and harness.
 * `change` is a transient sync marker (set by `PullsList` when a refresh surfaces a PR
 * that's new or whose `updatedAt` advanced) so the reviewer sees *what* changed, not
 * just that something did; it clears on the next sync.
 */
export function PullRow({
  owner,
  repo,
  pull,
  change,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
  change?: "new" | "updated";
}) {
  return (
    <a
      href={`/pr/${owner}/${repo}/${pull.number}`}
      className="group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5 shadow-card transition-colors hover:border-border-strong hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <GitPullRequest className="size-5 shrink-0 text-success" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{pull.title}</span>
          {change === "new" && <Badge variant="primary">New</Badge>}
          {change === "updated" && <Badge variant="warning">Updated</Badge>}
          {pull.draft && <Badge variant="outline">Draft</Badge>}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          #{pull.number}
          {pull.author ? ` · ${pull.author}` : ""} · updated {relativeTime(pull.updatedAt)}
        </p>
      </div>
      <ArrowRight className="size-4 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
    </a>
  );
}
