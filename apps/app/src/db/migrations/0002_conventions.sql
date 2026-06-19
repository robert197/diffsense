CREATE TABLE IF NOT EXISTS "conventions" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"notes" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conventions_owner_repo_unique" UNIQUE("owner","repo")
);
