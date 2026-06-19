import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Database;
  client: postgres.Sql;
}

/**
 * Build a typed Drizzle connection from a `DATABASE_URL`. Callers own the
 * lifecycle and must call `client.end()` when done.
 */
export function createDb(databaseUrl: string, opts?: { max?: number }): DbHandle {
  const client = postgres(databaseUrl, { max: opts?.max ?? 10 });
  const db = drizzle(client, { schema });
  return { db, client };
}
