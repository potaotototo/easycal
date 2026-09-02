import { randomUUID } from "node:crypto";
import type { Queryable } from "../types.js";

export type SyncRunStatus = "queued" | "running" | "completed" | "failed";

export async function createSyncRun(db: Queryable, connectionId: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into sync_runs (id, connection_id, status) values ($1, $2, 'queued')`,
    [id, connectionId],
  );
  return id;
}

export async function markSyncRunRunning(db: Queryable, runId: string): Promise<void> {
  await db.query(
    `update sync_runs set status = 'running', started_at = now() where id = $1`,
    [runId],
  );
}

export async function finishSyncRun(
  db: Queryable,
  runId: string,
  status: "completed" | "failed",
  errorCode?: string,
): Promise<void> {
  await db.query(
    `update sync_runs set status = $2, completed_at = now(), error_code = $3 where id = $1`,
    [runId, status, errorCode ?? null],
  );
}

/** Backs the rate limit on POST /v1/sync-runs. */
export async function countRecentRuns(
  db: Queryable,
  connectionId: string,
  withinSeconds: number,
): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as count from sync_runs
      where connection_id = $1
        and coalesce(started_at, completed_at, now()) > now() - ($2 || ' seconds')::interval`,
    [connectionId, String(withinSeconds)],
  );
  return (rows[0]?.["count"] as number) ?? 0;
}

export async function getCursor(
  db: Queryable,
  connectionId: string,
  sourceChatId: string,
): Promise<string | null> {
  const { rows } = await db.query(
    `select last_message_id from sync_cursors
      where connection_id = $1 and source_chat_id = $2`,
    [connectionId, sourceChatId],
  );
  return (rows[0]?.["last_message_id"] as string | undefined) ?? null;
}

export async function advanceCursor(
  db: Queryable,
  connectionId: string,
  sourceChatId: string,
  lastMessageId: string,
): Promise<void> {
  await db.query(
    `insert into sync_cursors (connection_id, source_chat_id, last_message_id, last_synced_at)
     values ($1, $2, $3, now())
     on conflict (connection_id, source_chat_id) do update
       set last_message_id = greatest(
             sync_cursors.last_message_id::bigint, excluded.last_message_id::bigint
           )::text,
           last_synced_at = now()`,
    [connectionId, sourceChatId, lastMessageId],
  );
}

export interface ClaimedRun {
  runId: string;
  connectionId: string;
}

/**
 * Atomically claims one queued run. `for update skip locked` means several workers
 * can poll the same table without ever handing the same run to two of them.
 */
export async function claimNextQueuedRun(db: Queryable): Promise<ClaimedRun | null> {
  const { rows } = await db.query(
    `update sync_runs
        set status = 'running', started_at = now()
      where id = (
        select id from sync_runs
         where status = 'queued'
         order by id
         for update skip locked
         limit 1
      )
      returning id, connection_id`,
  );
  return rows[0]
    ? { runId: rows[0]["id"] as string, connectionId: rows[0]["connection_id"] as string }
    : null;
}

/** The user id and timezone a run needs, resolved from its connection. */
export async function findSyncTarget(
  db: Queryable,
  connectionId: string,
): Promise<{ userId: string; deviceTimezone: string } | null> {
  const { rows } = await db.query(
    `select u.id as user_id, u.device_timezone
       from telegram_connections c join users u on u.id = c.user_id
      where c.id = $1`,
    [connectionId],
  );
  return rows[0]
    ? {
        userId: rows[0]["user_id"] as string,
        deviceTimezone: rows[0]["device_timezone"] as string,
      }
    : null;
}
