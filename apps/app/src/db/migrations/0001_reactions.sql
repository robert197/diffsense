CREATE TABLE IF NOT EXISTS "reactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"tier" text NOT NULL,
	"sentiment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
