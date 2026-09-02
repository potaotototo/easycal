import { randomUUID } from "node:crypto";
import { generateToken, hashToken } from "../tokens.js";
import type { Queryable } from "../types.js";

export const SESSION_TTL_DAYS = 30;

export interface IssuedSession {
  /** Returned to the caller once; never stored in plaintext. */
  token: string;
  expiresAt: Date;
}

export async function issueSession(db: Queryable, userId: string): Promise<IssuedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.query(
    `insert into user_sessions (id, user_id, token_hash, expires_at)
     values ($1, $2, $3, $4)`,
    [randomUUID(), userId, hashToken(token), expiresAt],
  );
  return { token, expiresAt };
}

/** Resolves a bearer token to a user id, ignoring expired and revoked sessions. */
export async function findUserIdBySessionToken(
  db: Queryable,
  token: string,
): Promise<string | null> {
  const { rows } = await db.query(
    `select user_id from user_sessions
      where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ? (rows[0]["user_id"] as string) : null;
}

export async function revokeSession(db: Queryable, token: string): Promise<void> {
  await db.query(
    `update user_sessions set revoked_at = now()
      where token_hash = $1 and revoked_at is null`,
    [hashToken(token)],
  );
}
