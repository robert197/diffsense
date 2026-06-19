import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./apps/app/src/db/schema.ts",
  out: "./apps/app/src/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
