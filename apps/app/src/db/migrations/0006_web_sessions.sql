CREATE TABLE IF NOT EXISTS "web_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"github_user_id" integer NOT NULL,
	"github_login" text NOT NULL,
	"github_avatar_url" text,
	"access_token_encrypted" text NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_encrypted" text,
	"refresh_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_sessions_expires_at_idx" ON "web_sessions" ("expires_at");
