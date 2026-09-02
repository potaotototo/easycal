import { randomUUID } from "node:crypto";
import {
  EnvKeyProvider,
  createSnapshot,
  findSnapshotByToken,
  listEvents,
  listChatsInFolder,
  revokeSnapshot,
  saveConnection,
  saveFolderSelection,
  startTestDatabase,
  upsertUserByTelegramId,
  type TestDatabase,
} from "@easycal/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_CAREERS,
  CHAT_START_IT,
  fakeTelegramData,
  SYNC_NOW,
} from "../__fixtures__/messages.js";
import { StubEventParser } from "../parser/stub.js";
import { FakeTelegramPort } from "../telegram/fake.js";
import { runSyncForConnection } from "./engine.js";

/**
 * Person A's acceptance check from docs/workstreams.md:
 *
 *   "after choosing a folder, a test connection can sync fixture-equivalent
 *    messages, persist events, export ICS, and return a public snapshot with no
 *    raw-message content."
 *
 * Runs against a real Postgres (embedded, throwaway) and a fake Telegram, so it
 * needs no Docker, no network and no Telegram account.
 */

const KEY = Buffer.alloc(32, 7).toString("base64");

let database: TestDatabase;
let userId: string;
let connectionId: string;
let telegram: FakeTelegramPort;

beforeAll(async () => {
  database = await startTestDatabase();

  const user = await upsertUserByTelegramId(database.pool, "555000111", "Asia/Singapore");
  userId = user.id;

  const connection = await saveConnection(
    database.pool,
    new EnvKeyProvider(KEY),
    userId,
    "fake-session-string",
  );
  connectionId = connection.id;

  // The user chooses a folder.
  await saveFolderSelection(database.pool, {
    connectionId,
    telegramFolderId: 2,
    folderTitle: "Opportunities",
    lookbackDays: 7,
  });

  telegram = new FakeTelegramPort(fakeTelegramData());
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

function sync() {
  return runSyncForConnection(
    {
      db: database.pool,
      telegram,
      parser: new StubEventParser(),
      overlapHours: 24,
      now: () => SYNC_NOW,
    },
    { connectionId, userId, deviceTimezone: "Asia/Singapore" },
  );
}

describe("acceptance: folder to public snapshot", () => {
  it("syncs the selected folder and persists raw messages", async () => {
    const result = await sync();

    expect(result.status).toBe("completed");
    expect(result.chatsInFolder).toBe(2);
    expect(result.messagesIngested).toBe(4);

    const { rows } = await database.pool.query("select count(*)::int as n from raw_messages");
    expect(rows[0].n).toBe(4);
  });

  it("produces the NOC event with the correct date, time and RSVP url", async () => {
    const events = await listEvents(database.pool, userId);
    const noc = events.find((event) => event.title === "NOC sharing");

    expect(noc).toBeDefined();
    expect(noc!.eventDate).toBe("2025-09-02");
    // 16:00 Asia/Singapore is 08:00 UTC — the offset must survive the round trip.
    expect(noc!.startAt).toBe("2025-09-02T08:00:00.000Z");
    expect(noc!.endAt).toBe("2025-09-02T10:00:00.000Z");
    expect(noc!.allDay).toBe(false);
    expect(noc!.rsvpUrl).toBe("https://forms.cloud.microsoft/r/0YVwa8YMEy");
    expect(noc!.locationName).toBe("NUS Enterprise I3 MPH, Level 2");
    expect(noc!.sourceLabel).toBe("NUS Start IT");
  });

  it("treats a date without a time as an all-day event", async () => {
    const events = await listEvents(database.pool, userId);
    const fair = events.find((event) => event.title === "Career fair");

    expect(fair).toBeDefined();
    expect(fair!.allDay).toBe(true);
    expect(fair!.eventDate).toBe("2025-09-15");
    expect(fair!.startAt).toBeNull();
    expect(fair!.endAt).toBeNull();
  });

  it("leaves a message with no date unconfirmed, never a calendar event", async () => {
    const events = await listEvents(database.pool, userId);
    expect(events.some((event) => /hiring interns/i.test(event.title))).toBe(false);

    const { rows } = await database.pool.query(
      "select count(*)::int as n from event_candidates where status = 'unconfirmed'",
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("is idempotent: a second sync duplicates nothing", async () => {
    const before = await countAll();
    const result = await sync();
    const after = await countAll();

    expect(result.status).toBe("completed");
    // The cursor means the same messages are not re-ingested...
    expect(after.messages).toBe(before.messages);
    // ...and re-derived chains update rather than duplicate their candidates.
    expect(after.candidates).toBe(before.candidates);
    expect(after.events).toBe(before.events);
  });

  it("follows the folder when a chat leaves it", async () => {
    const data = fakeTelegramData();
    data.chatsByFolder[2] = [CHAT_START_IT]; // Careers Board removed from the folder
    telegram.setData(data);

    await sync();

    const inFolder = await listChatsInFolder(database.pool, connectionId);
    expect(inFolder.map((chat) => chat.telegramChatId)).toEqual([CHAT_START_IT.telegramChatId]);

    // Its already-ingested messages are kept, not deleted.
    const { rows } = await database.pool.query(
      `select count(*)::int as n from raw_messages rm
         join source_chats sc on sc.id = rm.source_chat_id
        where sc.telegram_chat_id = $1`,
      [CHAT_CAREERS.telegramChatId],
    );
    expect(rows[0].n).toBe(2);
  });

  it("shares a public snapshot that contains no raw message content", async () => {
    const events = await listEvents(database.pool, userId);
    const snapshot = await createSnapshot(
      database.pool,
      userId,
      "September opportunities",
      events.map((event) => event.id),
    );

    const published = await findSnapshotByToken(database.pool, snapshot.token);
    expect(published).not.toBeNull();
    expect(published!.events.length).toBe(events.length);

    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain("RSVP here\n");
    expect(serialized).not.toContain("Follow @nusstartit");
    expect(serialized).not.toContain(CHAT_START_IT.telegramChatId);
    expect(serialized).not.toContain("telegramMessageId");
    expect(serialized).not.toContain("evidence");

    // The event itself is still there, with its public fields intact.
    expect(serialized).toContain("NOC sharing");
    expect(serialized).toContain("https://forms.cloud.microsoft/r/0YVwa8YMEy");
  });

  it("stores only a hash of the share token", async () => {
    const events = await listEvents(database.pool, userId);
    const snapshot = await createSnapshot(database.pool, userId, "Hashed", [events[0]!.id]);

    const { rows } = await database.pool.query(
      "select token_hash from share_snapshots where id = $1",
      [snapshot.id],
    );
    expect(rows[0].token_hash).not.toBe(snapshot.token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops serving a revoked snapshot", async () => {
    const events = await listEvents(database.pool, userId);
    const snapshot = await createSnapshot(database.pool, userId, "Temporary", [events[0]!.id]);

    expect(await findSnapshotByToken(database.pool, snapshot.token)).not.toBeNull();
    expect(await revokeSnapshot(database.pool, userId, snapshot.id)).toBe(true);
    expect(await findSnapshotByToken(database.pool, snapshot.token)).toBeNull();
  });

  it("scopes snapshots to their owner", async () => {
    const other = await upsertUserByTelegramId(database.pool, randomUUID(), "UTC");
    const events = await listEvents(database.pool, userId);
    const snapshot = await createSnapshot(database.pool, userId, "Mine", [events[0]!.id]);

    // Another user cannot revoke it.
    expect(await revokeSnapshot(database.pool, other.id, snapshot.id)).toBe(false);
    // And their own event list is empty.
    expect(await listEvents(database.pool, other.id)).toEqual([]);
  });
});

async function countAll() {
  const [messages, candidates, events] = await Promise.all([
    database.pool.query("select count(*)::int as n from raw_messages"),
    database.pool.query("select count(*)::int as n from event_candidates"),
    database.pool.query("select count(*)::int as n from calendar_events"),
  ]);
  return {
    messages: messages.rows[0].n as number,
    candidates: candidates.rows[0].n as number,
    events: events.rows[0].n as number,
  };
}
