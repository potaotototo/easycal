import type pg from "pg";

/**
 * Anything that can run a query: the pool itself, or a client enlisted in a
 * transaction. Repositories accept this so callers can compose several writes
 * atomically via `withTransaction`.
 */
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;
