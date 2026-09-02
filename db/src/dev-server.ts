/**
 * Local development database, with no Docker and nothing installed system-wide.
 *
 * `embedded-postgres` unpacks a real Postgres 17 server into node_modules and runs
 * it as a child process. The cluster is torn down when this script exits, so this
 * runs in the foreground: start it in its own terminal and stop it with Ctrl-C.
 * Data persists in db/.pgdata between runs.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".pgdata");

const USER = "easycal";
const PASSWORD = "easycal";
const DATABASE = "easycal";
const PORT = Number(process.env["PGPORT"] ?? 5432);

const reset = process.argv.includes("--reset");

const postgres = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
  // initdb output is noisy and only interesting when something breaks.
  onLog: () => {},
  onError: (error) => console.error(error),
});

async function main(): Promise<void> {
  if (reset) {
    await rm(DATA_DIR, { recursive: true, force: true });
    console.log("removed db/.pgdata");
  }

  // initialise() is only valid on an empty data directory; on later runs the
  // cluster already exists and we go straight to start().
  const alreadyInitialised = await isInitialised();
  if (!alreadyInitialised) {
    console.log("initialising a new Postgres cluster in db/.pgdata ...");
    await postgres.initialise();
  }

  await postgres.start();

  try {
    await postgres.createDatabase(DATABASE);
    console.log(`created database "${DATABASE}"`);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  console.log(
    [
      "",
      `Postgres 17 listening on port ${PORT}`,
      `DATABASE_URL=postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`,
      "",
      "Apply migrations from another terminal with:  pnpm migrate",
      "Stop this server with Ctrl-C. Wipe it with:   pnpm db:reset",
      "",
    ].join("\n"),
  );

  await blockUntilSignalled();
}

async function isInitialised(): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(path.join(DATA_DIR, "PG_VERSION"));
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "42P04"
  );
}

function blockUntilSignalled(): Promise<void> {
  return new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        console.log("\nstopping Postgres ...");
        void postgres
          .stop()
          .catch((error: unknown) => console.error(error))
          .finally(resolve);
      });
    }
  });
}

await main();
