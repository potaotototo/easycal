import {
  EnvKeyProvider,
  claimNextQueuedRun,
  closePool,
  createSyncRun,
  findSyncTarget,
  getPool,
  listSyncableConnections,
  loadSessionString,
  saveFolderCache,
} from "@easycal/db";
import { StubEventParser } from "./parser/stub.js";
import { runSyncForConnection } from "./sync/engine.js";
import { createClient, GramJsTelegramPort } from "./telegram/gramjs.js";
import { loadEnv } from "./env.js";
import { createEventCategoryClassifier } from "./classification/classifier.js";

/**
 * The worker owns Telegram access. It does two things on a loop:
 *
 *  - claims runs queued by `POST /v1/sync-runs` and executes them, and
 *  - enqueues a scheduled run per active connection every SYNC_INTERVAL_MINUTES.
 *
 * Queued runs live in `sync_runs`, so an interrupted worker resumes rather than
 * losing work, and `for update skip locked` keeps multiple workers safe.
 */

const env = loadEnv();
const db = getPool();
const parser = new StubEventParser(); // swap for Person B's parser at milestone 2
const classifier = createEventCategoryClassifier({
  apiKey: env.OPENAI_API_KEY,
  model: env.OPENAI_CATEGORY_MODEL,
});

const POLL_INTERVAL_MS = 5_000;
const SCHEDULE_INTERVAL_MS = Number(process.env["SYNC_INTERVAL_MINUTES"] ?? 15) * 60_000;

if (!env.SESSION_ENCRYPTION_KEY) {
  throw new Error("SESSION_ENCRYPTION_KEY is required: the worker decrypts Telegram sessions");
}
if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
  throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required to reach Telegram");
}

const keys = new EnvKeyProvider(env.SESSION_ENCRYPTION_KEY);
const credentials = { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH };

async function executeRun(runId: string, connectionId: string): Promise<void> {
  const target = await findSyncTarget(db, connectionId);
  if (!target) return;

  // Decryption happens here and nowhere else in the system.
  const sessionString = await loadSessionString(db, keys, connectionId);
  const client = await createClient(credentials, sessionString);
  const telegram = new GramJsTelegramPort(client);

  try {
    const folders = await telegram.listFolders();
    await saveFolderCache(
      db,
      connectionId,
      folders.map((folder) => ({ telegramFolderId: folder.id, title: folder.title })),
    );

    const result = await runSyncForConnection(
      {
        db,
        telegram,
        parser,
        classifier,
        overlapHours: env.SYNC_OVERLAP_HOURS,
        log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
      },
      { connectionId, userId: target.userId, deviceTimezone: target.deviceTimezone },
      { runId },
    );

    console.log(JSON.stringify({ message: "sync run finished", ...result }));
  } finally {
    await telegram.disconnect();
  }
}

async function pollOnce(): Promise<void> {
  const claimed = await claimNextQueuedRun(db);
  if (!claimed) return;
  try {
    await executeRun(claimed.runId, claimed.connectionId);
  } catch (error) {
    console.error(JSON.stringify({ message: "sync run threw", runId: claimed.runId }), error);
  }
}

async function scheduleAll(): Promise<void> {
  for (const connection of await listSyncableConnections(db)) {
    await createSyncRun(db, connection.id);
  }
}

const pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
const scheduleTimer = setInterval(() => void scheduleAll(), SCHEDULE_INTERVAL_MS);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(pollTimer);
    clearInterval(scheduleTimer);
    void closePool().then(() => process.exit(0));
  });
}

console.log(
  JSON.stringify({
    message: "worker started",
    pollIntervalMs: POLL_INTERVAL_MS,
    scheduleIntervalMs: SCHEDULE_INTERVAL_MS,
    overlapHours: env.SYNC_OVERLAP_HOURS,
  }),
);

// Do an initial scheduling pass so a freshly started worker syncs without waiting.
await scheduleAll().catch((error: unknown) => console.error(error));
