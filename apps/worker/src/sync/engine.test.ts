import {
  EnvKeyProvider,
  saveConnection,
  saveFolderSelection,
  startTestDatabase,
  upsertUserByTelegramId,
  type TestDatabase,
} from "@easycal/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_START_IT, fakeTelegramData, SYNC_NOW } from "../__fixtures__/messages.js";
import { RealEventParser } from "../parser/real.js";
import { FakeTelegramPort } from "../telegram/fake.js";
import {
  FloodWaitError,
  ReauthRequiredError,
  type FetchMessagesOptions,
  type TelegramChat,
} from "../telegram/port.js";
import { runSyncForConnection } from "./engine.js";
import { DeterministicEventCategoryClassifier } from "../classification/classifier.js";

const KEY = Buffer.alloc(32, 3).toString("base64");

let database: TestDatabase;
let userId: string;
let connectionId: string;

beforeAll(async () => {
  database = await startTestDatabase();
  const user = await upsertUserByTelegramId(database.pool, "999000111", "Asia/Singapore");
  userId = user.id;
  const connection = await saveConnection(
    database.pool,
    new EnvKeyProvider(KEY),
    userId,
    "session",
  );
  connectionId = connection.id;
  await saveFolderSelection(database.pool, {
    connectionId,
    telegramFolderId: 2,
    folderTitle: "Opportunities",
    lookbackDays: 7,
  });
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

function deps(telegram: FakeTelegramPort, sleep: (ms: number) => Promise<void>) {
  return {
    db: database.pool,
    telegram,
    parser: new RealEventParser(),
    classifier: new DeterministicEventCategoryClassifier(),
    overlapHours: 24,
    now: () => SYNC_NOW,
    sleep,
  };
}

const target = () => ({ connectionId, userId, deviceTimezone: "Asia/Singapore" });

describe("rate limiting", () => {
  it("honours the wait Telegram asks for, then succeeds", async () => {
    let attempts = 0;
    const slept: number[] = [];

    class FloodingPort extends FakeTelegramPort {
      override async fetchMessages(
        chat: TelegramChat,
        options: FetchMessagesOptions,
      ) {
        attempts += 1;
        if (attempts === 1) throw new FloodWaitError(7);
        return super.fetchMessages(chat, options);
      }
    }

    const telegram = new FloodingPort(fakeTelegramData());
    const result = await runSyncForConnection(
      deps(telegram, async (ms) => {
        slept.push(ms);
      }),
      target(),
    );

    expect(result.status).toBe("completed");
    // Waited exactly the 7 seconds Telegram named, rather than retrying blindly.
    expect(slept).toEqual([7000]);
    expect(attempts).toBeGreaterThan(1);
  });

  it("gives up after repeated flood waits and records the failure", async () => {
    class AlwaysFlooding extends FakeTelegramPort {
      override async fetchMessages() {
        throw new FloodWaitError(1);
      }
    }

    const result = await runSyncForConnection(
      deps(new AlwaysFlooding(fakeTelegramData()), async () => {}),
      target(),
    );

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("rate_limited");

    const { rows } = await database.pool.query(
      "select status, error_code from sync_runs where id = $1",
      [result.runId],
    );
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error_code).toBe("rate_limited");
  });
});

describe("expired sessions", () => {
  it("flags the connection for reauthorization instead of failing silently", async () => {
    class DeadSession extends FakeTelegramPort {
      override async resolveFolderChats(): Promise<never> {
        throw new ReauthRequiredError("AUTH_KEY_UNREGISTERED");
      }
    }

    const result = await runSyncForConnection(
      deps(new DeadSession(fakeTelegramData()), async () => {}),
      target(),
    );

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("reauth_required");

    const { rows } = await database.pool.query(
      "select status from telegram_connections where id = $1",
      [connectionId],
    );
    // The user is told to reconnect rather than seeing an empty calendar forever.
    expect(rows[0].status).toBe("reauth_required");
  });
});

describe("cursors", () => {
  it("advances a cursor per chat so the next run resumes", async () => {
    await database.pool.query("update telegram_connections set status = 'active' where id = $1", [
      connectionId,
    ]);

    const telegram = new FakeTelegramPort(fakeTelegramData());
    await runSyncForConnection(deps(telegram, async () => {}), target());

    const { rows } = await database.pool.query(
      `select c.last_message_id from sync_cursors c
         join source_chats s on s.id = c.source_chat_id
        where s.telegram_chat_id = $1`,
      [CHAT_START_IT.telegramChatId],
    );
    // 1004 is the newest message in that chat.
    expect(rows[0].last_message_id).toBe("1004");
  });
});
