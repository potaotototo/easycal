import { randomUUID } from "node:crypto";
import type { Queryable } from "../types.js";

export interface SourceChatRow {
  id: string;
  connectionId: string;
  telegramChatId: string;
  title: string;
  username: string | null;
  isCurrentlyInFolder: boolean;
}

export interface ResolvedChat {
  telegramChatId: string;
  title: string;
  username: string | null;
}

/**
 * Records the chats the selected folder currently resolves to. The folder is a
 * dynamic Telegram filter, so this runs on every sync: chats that have dropped out
 * are flagged rather than deleted, keeping their already-ingested messages intact.
 */
export async function syncFolderChats(
  db: Queryable,
  connectionId: string,
  resolved: ResolvedChat[],
): Promise<SourceChatRow[]> {
  for (const chat of resolved) {
    await db.query(
      `insert into source_chats
         (id, connection_id, telegram_chat_id, title, username, is_currently_in_folder)
       values ($1, $2, $3, $4, $5, true)
       on conflict (connection_id, telegram_chat_id) do update
         set title = excluded.title,
             username = excluded.username,
             is_currently_in_folder = true`,
      [randomUUID(), connectionId, chat.telegramChatId, chat.title, chat.username],
    );
  }

  const ids = resolved.map((chat) => chat.telegramChatId);
  await db.query(
    `update source_chats set is_currently_in_folder = false
      where connection_id = $1 and not (telegram_chat_id = any($2::text[]))`,
    [connectionId, ids],
  );

  return listChatsInFolder(db, connectionId);
}

export async function listChatsInFolder(
  db: Queryable,
  connectionId: string,
): Promise<SourceChatRow[]> {
  const { rows } = await db.query(
    `select id, connection_id, telegram_chat_id, title, username, is_currently_in_folder
       from source_chats
      where connection_id = $1 and is_currently_in_folder
      order by title`,
    [connectionId],
  );
  return rows.map((row) => ({
    id: row["id"] as string,
    connectionId: row["connection_id"] as string,
    telegramChatId: row["telegram_chat_id"] as string,
    title: row["title"] as string,
    username: row["username"] as string | null,
    isCurrentlyInFolder: row["is_currently_in_folder"] as boolean,
  }));
}
