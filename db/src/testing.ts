import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { configurePgTypes } from "./pgTypes.js";

configurePgTypes();

/**
 * A throwaway Postgres for tests. Uses the same embedded binaries as `pnpm db`, so
 * the whole pipeline can be verified with no Docker, no system Postgres, and no
 * interference with the developer's own database.
 */

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export interface TestDatabase {
  connectionString: string;
  pool: pg.Pool;
  stop: () => Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  // A random port keeps concurrent test runs (and the dev server on 5432) apart.
  const port = 20000 + Math.floor(Math.random() * 20000);
  const databaseDir = path.join(
    process.env["TMPDIR"] ?? "/tmp",
    `easycal-test-${process.pid}-${port}`,
  );

  const postgres = new EmbeddedPostgres({
    databaseDir,
    user: "test",
    password: "test",
    port,
    persistent: false, // stop() deletes the data directory
    onLog: () => {},
    onError: () => {},
  });

  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase("easycal_test");

  const connectionString = `postgres://test:test@localhost:${port}/easycal_test`;
  const pool = new pg.Pool({ connectionString });
  await applyMigrations(pool);

  return {
    connectionString,
    pool,
    stop: async () => {
      await pool.end();
      await postgres.stop();
    },
  };
}

/**
 * Applies the same migration files `pnpm migrate` runs, so tests exercise the real
 * schema rather than a hand-maintained copy that can drift.
 */
export async function applyMigrations(db: pg.Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();

  for (const file of files) {
    const contents = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const up = contents.split(/^--\s*Down Migration\s*$/m)[0];
    if (!up) continue;
    const statements = up.replace(/^--\s*Up Migration\s*$/m, "");
    await db.query(statements);
  }
}
