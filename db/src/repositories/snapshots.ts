import { randomUUID } from "node:crypto";
import type { ShareSnapshotEvent } from "@easycal/contracts/event";
import { toPublicPayload } from "../publicPayload.js";
import { generateToken, hashToken } from "../tokens.js";
import type { Queryable } from "../types.js";
import { findEventById } from "./events.js";

export interface CreatedSnapshot {
  id: string;
  /** Shown once, at creation; only its hash is stored. */
  token: string;
  title: string;
  eventCount: number;
}

/**
 * Copies the selected events into the snapshot as immutable public payloads. The
 * public view never reads back through to `calendar_events`, so later edits and
 * dismissals cannot change or leak into an already-shared link.
 */
export async function createSnapshot(
  db: Queryable,
  userId: string,
  title: string,
  eventIds: string[],
): Promise<CreatedSnapshot> {
  const token = generateToken();
  const id = randomUUID();

  await db.query(
    `insert into share_snapshots (id, user_id, token_hash, title) values ($1, $2, $3, $4)`,
    [id, userId, hashToken(token), title],
  );

  let position = 0;
  for (const eventId of eventIds) {
    const event = await findEventById(db, userId, eventId);
    if (!event) continue; // silently skip events that are not this user's
    await db.query(
      `insert into share_snapshot_events (snapshot_id, event_id, public_payload, position)
       values ($1, $2, $3::jsonb, $4)
       on conflict (snapshot_id, event_id) do nothing`,
      [id, eventId, JSON.stringify(toPublicPayload(event)), position],
    );
    position += 1;
  }

  return { id, token, title, eventCount: position };
}

export interface PublicSnapshot {
  title: string;
  createdAt: string;
  events: ShareSnapshotEvent[];
}

/** Resolves a public bearer token. Revoked snapshots resolve to null (404). */
export async function findSnapshotByToken(
  db: Queryable,
  token: string,
): Promise<PublicSnapshot | null> {
  const { rows } = await db.query(
    `select id, title, created_at from share_snapshots
      where token_hash = $1 and revoked_at is null`,
    [hashToken(token)],
  );
  const snapshot = rows[0];
  if (!snapshot) return null;

  const { rows: eventRows } = await db.query(
    `select public_payload from share_snapshot_events
      where snapshot_id = $1 order by position asc`,
    [snapshot["id"]],
  );

  return {
    title: snapshot["title"] as string,
    createdAt: (snapshot["created_at"] as Date).toISOString(),
    events: eventRows.map((row) => row["public_payload"] as ShareSnapshotEvent),
  };
}

export async function revokeSnapshot(
  db: Queryable,
  userId: string,
  snapshotId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update share_snapshots set revoked_at = now()
      where id = $1 and user_id = $2 and revoked_at is null`,
    [snapshotId, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function listSnapshots(
  db: Queryable,
  userId: string,
): Promise<Array<{ id: string; title: string; createdAt: string; revokedAt: string | null }>> {
  const { rows } = await db.query(
    `select id, title, created_at, revoked_at from share_snapshots
      where user_id = $1 order by created_at desc`,
    [userId],
  );
  return rows.map((row) => ({
    id: row["id"] as string,
    title: row["title"] as string,
    createdAt: (row["created_at"] as Date).toISOString(),
    revokedAt: (row["revoked_at"] as Date | null)?.toISOString() ?? null,
  }));
}
