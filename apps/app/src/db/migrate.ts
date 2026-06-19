import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadDatabaseUrl } from "../config.js";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

/** Apply all pending Drizzle migrations, then close the one-shot connection. */
export async function runMigrations(databaseUrl: string = loadDatabaseUrl()): Promise<void> {
  const migrationClient = postgres(databaseUrl, { max: 1 });
  try {
    const db = drizzle(migrationClient);
    await migrate(db, { migrationsFolder });
  } finally {
    await migrationClient.end();
  }
}

// Run directly: `tsx apps/app/src/db/migrate.ts` (compose migrate step / CI).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations()
    .then(() => {
      console.log("migrations applied");
      process.exit(0);
    })
    .catch((err) => {
      console.error("migration failed:", err);
      process.exit(1);
    });
}
