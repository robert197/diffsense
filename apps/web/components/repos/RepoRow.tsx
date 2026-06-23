import { ArrowRight, FolderGit2, Lock } from "lucide-react";
import type { Repository } from "../../lib/github";
import { Badge } from "../ui/badge";

/** A tappable repo row → its open PRs. Shared by the repo picker and the QA harness. */
export function RepoRow({ repo }: { repo: Repository }) {
  return (
    <a
      href={`/repos/${repo.owner}/${repo.name}/pulls`}
      className="group flex min-h-14 items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-card transition-colors hover:border-border-strong hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <FolderGit2 className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{repo.name}</span>
          {repo.private && (
            <Badge variant="outline" className="gap-1">
              <Lock />
              Private
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">{repo.fullName}</p>
      </div>
      <ArrowRight className="size-4 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
    </a>
  );
}
