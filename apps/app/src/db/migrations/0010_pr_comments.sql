CREATE TABLE IF NOT EXISTS "pr_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_user_id" integer NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"fingerprint" text NOT NULL,
	"body" text NOT NULL,
	"github_comment_id" integer NOT NULL,
	"html_url" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_comments_github_comment_id_unique" UNIQUE("github_comment_id"),
	CONSTRAINT "pr_comments_kind_check" CHECK ("kind" IN ('review', 'issue'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_comments_reviewer_idx" ON "pr_comments" ("github_user_id","owner","repo","pr_number","head_sha");
