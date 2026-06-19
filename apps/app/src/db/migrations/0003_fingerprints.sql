CREATE TABLE IF NOT EXISTS "fingerprints" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"fingerprint" text NOT NULL,
	"review" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fingerprints_owner_repo_fingerprint_unique" UNIQUE("owner","repo","fingerprint")
);
