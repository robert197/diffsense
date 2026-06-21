CREATE TABLE IF NOT EXISTS "card_localizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"fingerprint" text NOT NULL,
	"language" text NOT NULL,
	"localized" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_localizations_owner_repo_fp_lang_unique" UNIQUE("owner","repo","fingerprint","language")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_localizations_card_idx" ON "card_localizations" ("owner","repo","fingerprint");
