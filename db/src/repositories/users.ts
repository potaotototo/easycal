import { randomUUID } from "node:crypto";
import type { Queryable } from "../types.js";

export interface UserRow {
  id: string;
  telegramUserId: string;
  deviceTimezone: string;
  createdAt: Date;
}

/**
 * The Telegram account is the app identity, so a completed login either finds the
 * existing user or creates one. `device_timezone` is only overwritten when the
 * caller actually knows it, so a later login from a tool that omits it does not
 * clobber the browser-supplied value.
 */
export async function upsertUserByTelegramId(
  db: Queryable,
  telegramUserId: string,
  deviceTimezone?: string,
): Promise<UserRow> {
  const { rows } = await db.query(
    `insert into users (id, telegram_user_id, device_timezone)
     values ($1, $2, coalesce($3, 'UTC'))
     on conflict (telegram_user_id) do update
       set device_timezone = coalesce($3, users.device_timezone)
     returning id, telegram_user_id, device_timezone, created_at`,
    [randomUUID(), telegramUserId, deviceTimezone ?? null],
  );
  return mapUser(rows[0]);
}

export async function findUserById(db: Queryable, id: string): Promise<UserRow | null> {
  const { rows } = await db.query(
    `select id, telegram_user_id, device_timezone, created_at from users where id = $1`,
    [id],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

function mapUser(row: Record<string, unknown>): UserRow {
  return {
    id: row["id"] as string,
    telegramUserId: row["telegram_user_id"] as string,
    deviceTimezone: row["device_timezone"] as string,
    createdAt: row["created_at"] as Date,
  };
}
