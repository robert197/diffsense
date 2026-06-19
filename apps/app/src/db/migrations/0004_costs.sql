CREATE TABLE IF NOT EXISTS "costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"over_threshold" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
