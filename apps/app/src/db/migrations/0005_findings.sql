CREATE TABLE IF NOT EXISTS "findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"file" text NOT NULL,
	"tier" text NOT NULL,
	"rank" integer NOT NULL,
	"explanation" text NOT NULL,
	"claims" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"blast_radius" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "findings_pr_idx" ON "findings" ("owner","repo","pr_number");
