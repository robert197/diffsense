CREATE TABLE IF NOT EXISTS "review_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_user_id" integer NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"fingerprint" text NOT NULL,
	"decision" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_progress_user_pr_head_fp_unique" UNIQUE("github_user_id","owner","repo","pr_number","head_sha","fingerprint"),
	CONSTRAINT "review_progress_decision_check" CHECK ("decision" IN ('up', 'down'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_progress_user_idx" ON "review_progress" ("github_user_id");
