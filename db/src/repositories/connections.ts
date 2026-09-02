import { randomUUID } from "node:crypto";
import type { KeyProvider } from "../crypto.js";
import type { Queryable } from "../types.js";

export type ConnectionStatus = "active" | "reauth_required" | "revoked";

export interface ConnectionRow {
  id: string;
  userId: string;
  status: ConnectionStatus;
}

/**
 * Stores the Telegram session encrypted. Callers pass an encrypt-only provider
 * where possible so the storing component cannot read the material back.
 */
export async function saveConnection(
  db: Queryable,
  keys: Pick<KeyProvider, "encrypt">,
  userId: string,
  sessionString: string,
): Promise<ConnectionRow> {
  const encrypted = await keys.encrypt(sessionString);
  const { rows } = await db.query(
    `insert into telegram_connections (id, user_id, encrypted_session, status)
     values ($1, $2, $3, 'active')
     returning id, user_id, status`,
    [randomUUID(), userId, encrypted],
  );
  return mapConnection(rows[0]);
}

/** Replaces the stored session for a user, marking any previous one revoked. */
export async function replaceConnection(
  db: Queryable,
  keys: Pick<KeyProvider, "encrypt">,
  userId: string,
  sessionString: string,
): Promise<ConnectionRow> {
  await db.query(
    `update telegram_connections set status = 'revoked', updated_at = now()
      where user_id = $1 and status <> 'revoked'`,
    [userId],
  );
  return saveConnection(db, keys, userId, sessionString);
}

export async function findActiveConnectionByUser(
  db: Queryable,
  userId: string,
): Promise<ConnectionRow | null> {
  const { rows } = await db.query(
    `select id, user_id, status from telegram_connections
      where user_id = $1 and status <> 'revoked'
      order by created_at desc limit 1`,
    [userId],
  );
  return rows[0] ? mapConnection(rows[0]) : null;
}

export async function listSyncableConnections(db: Queryable): Promise<ConnectionRow[]> {
  const { rows } = await db.query(
    `select c.id, c.user_id, c.status from telegram_connections c
       join folder_selections f on f.connection_id = c.id
      where c.status = 'active'`,
  );
  return rows.map(mapConnection);
}

/**
 * Decryption is deliberately a separate function from the read helpers: only the
 * worker is wired with a provider that can call it.
 */
export async function loadSessionString(
  db: Queryable,
  keys: KeyProvider,
  connectionId: string,
): Promise<string> {
  const { rows } = await db.query(
    `select encrypted_session from telegram_connections where id = $1`,
    [connectionId],
  );
  if (!rows[0]) throw new Error(`No such connection: ${connectionId}`);
  return keys.decrypt(rows[0]["encrypted_session"] as Buffer);
}

export async function markConnectionStatus(
  db: Queryable,
  connectionId: string,
  status: ConnectionStatus,
): Promise<void> {
  await db.query(
    `update telegram_connections set status = $2, updated_at = now() where id = $1`,
    [connectionId, status],
  );
}

function mapConnection(row: Record<string, unknown>): ConnectionRow {
  return {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    status: row["status"] as ConnectionStatus,
  };
}
