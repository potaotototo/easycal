import pg from "pg";
import { configurePgTypes } from "./pgTypes.js";

configurePgTypes();

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

let pool: pg.Pool | undefined;

/**
 * Shared connection pool for both apps/api and apps/worker. Callers never
 * construct their own pool, so connection limits stay observable in one place.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set (see .env.example)");
    }
    pool = new pg.Pool({ connectionString });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = undefined;
    await closing.end();
  }
}

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
