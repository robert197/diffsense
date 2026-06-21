CREATE TABLE IF NOT EXISTS "decks" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"cards" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decks_owner_repo_pr_head_unique" UNIQUE("owner","repo","pr_number","head_sha")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decks_pr_idx" ON "decks" ("owner","repo","pr_number");
