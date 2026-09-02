import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../types.js";

export interface LinkEntityRow {
  label: string;
  url: string;
  offset: number;
  length: number;
}

export interface RawMessageInput {
  connectionId: string;
  sourceChatId: string;
  telegramMessageId: string;
  sentAt: Date;
  rawText: string;
  normalizedText: string;
  entities: LinkEntityRow[];
  replyToMessageId: string | null;
}

export interface RawMessageRow extends RawMessageInput {
  id: string;
  contentHash: string;
}

export function contentHashOf(rawText: string, entities: LinkEntityRow[]): string {
  return createHash("sha256")
    .update(rawText)
    .update(JSON.stringify(entities))
    .digest("hex");
}

/**
 * Idempotent ingest. A re-sync of the overlap window sees the same messages again,
 * so the unique key does the deduplication; an edited message updates in place and
 * its new content hash makes the edit visible to the parser.
 */
export async function upsertRawMessages(
  db: Queryable,
  messages: RawMessageInput[],
): Promise<RawMessageRow[]> {
  const saved: RawMessageRow[] = [];
  for (const message of messages) {
    const contentHash = contentHashOf(message.rawText, message.entities);
    const { rows } = await db.query(
      `insert into raw_messages
         (id, connection_id, source_chat_id, telegram_message_id, sent_at,
          raw_text, normalized_text, entities, reply_to_message_id, content_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       on conflict (connection_id, source_chat_id, telegram_message_id) do update
         set raw_text = excluded.raw_text,
             normalized_text = excluded.normalized_text,
             entities = excluded.entities,
             reply_to_message_id = excluded.reply_to_message_id,
             content_hash = excluded.content_hash
       returning id`,
      [
        randomUUID(),
        message.connectionId,
        message.sourceChatId,
        message.telegramMessageId,
        message.sentAt,
        message.rawText,
        message.normalizedText,
        JSON.stringify(message.entities),
        message.replyToMessageId,
        contentHash,
      ],
    );
    saved.push({ ...message, id: rows[0]!["id"] as string, contentHash });
  }
  return saved;
}

/** Messages for one chat inside the sync window, oldest first, for chain assembly. */
export async function listMessagesForChat(
  db: Queryable,
  sourceChatId: string,
  since: Date,
): Promise<RawMessageRow[]> {
  const { rows } = await db.query(
    `select id, connection_id, source_chat_id, telegram_message_id, sent_at,
            raw_text, normalized_text, entities, reply_to_message_id, content_hash
       from raw_messages
      where source_chat_id = $1 and sent_at >= $2
      order by sent_at asc, telegram_message_id asc`,
    [sourceChatId, since],
  );
  return rows.map((row) => ({
    id: row["id"] as string,
    connectionId: row["connection_id"] as string,
    sourceChatId: row["source_chat_id"] as string,
    telegramMessageId: row["telegram_message_id"] as string,
    sentAt: row["sent_at"] as Date,
    rawText: row["raw_text"] as string,
    normalizedText: row["normalized_text"] as string,
    entities: row["entities"] as LinkEntityRow[],
    replyToMessageId: row["reply_to_message_id"] as string | null,
    contentHash: row["content_hash"] as string,
  }));
}
