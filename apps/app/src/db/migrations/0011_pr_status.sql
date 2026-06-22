CREATE TABLE IF NOT EXISTS "pr_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"status" text NOT NULL,
	"installation_id" integer NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_status_owner_repo_pr_unique" UNIQUE("owner","repo","pr_number"),
	CONSTRAINT "pr_status_status_check" CHECK ("status" IN ('open', 'merged', 'closed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_status_poll_idx" ON "pr_status" ("status","synced_at");
