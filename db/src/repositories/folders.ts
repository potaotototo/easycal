import { randomUUID } from "node:crypto";
import type { Queryable } from "../types.js";

export interface FolderSelectionRow {
  connectionId: string;
  telegramFolderId: number;
  folderTitle: string;
  lookbackDays: number;
}

export async function saveFolderSelection(
  db: Queryable,
  selection: FolderSelectionRow,
): Promise<void> {
  await db.query(
    `insert into folder_selections
       (id, connection_id, telegram_folder_id, folder_title, lookback_days)
     values ($1, $2, $3, $4, $5)
     on conflict (connection_id) do update
       set telegram_folder_id = excluded.telegram_folder_id,
           folder_title       = excluded.folder_title,
           lookback_days      = excluded.lookback_days,
           updated_at         = now()`,
    [
      randomUUID(),
      selection.connectionId,
      selection.telegramFolderId,
      selection.folderTitle,
      selection.lookbackDays,
    ],
  );
}

export async function findFolderSelection(
  db: Queryable,
  connectionId: string,
): Promise<FolderSelectionRow | null> {
  const { rows } = await db.query(
    `select connection_id, telegram_folder_id, folder_title, lookback_days
       from folder_selections where connection_id = $1`,
    [connectionId],
  );
  const row = rows[0];
  return row
    ? {
        connectionId: row["connection_id"] as string,
        telegramFolderId: row["telegram_folder_id"] as number,
        folderTitle: row["folder_title"] as string,
        lookbackDays: row["lookback_days"] as number,
      }
    : null;
}

export interface CachedFolder {
  telegramFolderId: number;
  title: string;
}

/**
 * Replaces the cached folder list for a connection. Written by whoever currently
 * holds a live Telegram client: the API right after login, the worker on each sync.
 */
export async function saveFolderCache(
  db: Queryable,
  connectionId: string,
  folders: CachedFolder[],
): Promise<void> {
  for (const folder of folders) {
    await db.query(
      `insert into telegram_folders (connection_id, telegram_folder_id, title)
       values ($1, $2, $3)
       on conflict (connection_id, telegram_folder_id) do update
         set title = excluded.title, refreshed_at = now()`,
      [connectionId, folder.telegramFolderId, folder.title],
    );
  }
  const ids = folders.map((folder) => folder.telegramFolderId);
  await db.query(
    `delete from telegram_folders
      where connection_id = $1 and not (telegram_folder_id = any($2::int[]))`,
    [connectionId, ids],
  );
}

export async function listCachedFolders(
  db: Queryable,
  connectionId: string,
): Promise<Array<CachedFolder & { refreshedAt: string }>> {
  const { rows } = await db.query(
    `select telegram_folder_id, title, refreshed_at from telegram_folders
      where connection_id = $1 order by title`,
    [connectionId],
  );
  return rows.map((row) => ({
    telegramFolderId: row["telegram_folder_id"] as number,
    title: row["title"] as string,
    refreshedAt: (row["refreshed_at"] as Date).toISOString(),
  }));
}
