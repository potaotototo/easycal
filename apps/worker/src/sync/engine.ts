import {
  advanceCursor,
  createSyncRun,
  finishSyncRun,
  findFolderSelection,
  getCursor,
  listMessagesForChat,
  markConnectionStatus,
  markSyncRunRunning,
  syncFolderChats,
  upsertCalendarEvent,
  upsertRawMessages,
  saveCandidate,
  type Queryable,
  type RawMessageInput,
} from "@easycal/db";
import { assembleChains } from "../parser/chains.js";
import type { EventParser } from "../parser/contract.js";
import type { EventCategoryClassifier } from "../classification/classifier.js";
import {
  FloodWaitError,
  ReauthRequiredError,
  normalizeText,
  type TelegramChat,
  type TelegramPort,
} from "../telegram/port.js";

export interface SyncDeps {
  db: Queryable;
  telegram: TelegramPort;
  parser: EventParser;
  classifier: EventCategoryClassifier;
  /** Hours re-read on top of the lookback window so edits and late replies land. */
  overlapHours: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface SyncTarget {
  connectionId: string;
  userId: string;
  deviceTimezone: string;
}

export interface SyncResult {
  runId: string;
  status: "completed" | "failed";
  chatsInFolder: number;
  messagesIngested: number;
  candidatesWritten: number;
  eventsWritten: number;
  errorCode?: string;
}

const MAX_FLOOD_RETRIES = 3;

/**
 * One synchronization run for one connection.
 *
 * Ordering matters: the folder is resolved first (it is a live filter, so its
 * membership may have changed since the last run), then messages are ingested and
 * deduplicated, and only then is the parser asked to interpret them.
 */
export async function runSyncForConnection(
  deps: SyncDeps,
  target: SyncTarget,
  options: { runId?: string } = {},
): Promise<SyncResult> {
  const { db, telegram, parser, classifier } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});

  // A run enqueued by POST /v1/sync-runs has already been claimed and marked
  // running by the poller; a scheduled run creates its own.
  let runId = options.runId;
  if (!runId) {
    runId = await createSyncRun(db, target.connectionId);
    await markSyncRunRunning(db, runId);
  }

  const result: SyncResult = {
    runId,
    status: "completed",
    chatsInFolder: 0,
    messagesIngested: 0,
    candidatesWritten: 0,
    eventsWritten: 0,
  };

  try {
    const selection = await findFolderSelection(db, target.connectionId);
    if (!selection) {
      await finishSyncRun(db, runId, "completed");
      return result;
    }

    const since = new Date(
      now().getTime() -
        (selection.lookbackDays * 24 + deps.overlapHours) * 60 * 60 * 1000,
    );

    const resolved = await withFloodRetry(
      () => telegram.resolveFolderChats(selection.telegramFolderId),
      sleep,
      log,
    );
    const chats = await syncFolderChats(
      db,
      target.connectionId,
      resolved.map((chat) => ({
        telegramChatId: chat.telegramChatId,
        title: chat.title,
        username: chat.username,
      })),
    );
    result.chatsInFolder = chats.length;

    for (const chat of chats) {
      const telegramChat: TelegramChat = {
        telegramChatId: chat.telegramChatId,
        title: chat.title,
        username: chat.username,
      };

      const cursor = await getCursor(db, target.connectionId, chat.id);
      const fetched = await withFloodRetry(
        () => telegram.fetchMessages(telegramChat, { since, minMessageId: cursor }),
        sleep,
        log,
      );

      if (fetched.length > 0) {
        const inputs: RawMessageInput[] = fetched.map((message) => ({
          connectionId: target.connectionId,
          sourceChatId: chat.id,
          telegramMessageId: message.telegramMessageId,
          sentAt: message.sentAt,
          rawText: message.rawText,
          normalizedText: normalizeText(message.rawText),
          entities: message.entities,
          replyToMessageId: message.replyToMessageId,
        }));
        await upsertRawMessages(db, inputs);
        result.messagesIngested += inputs.length;

        const newest = fetched.reduce((max, message) =>
          Number(message.telegramMessageId) > Number(max.telegramMessageId) ? message : max,
        );
        await advanceCursor(db, target.connectionId, chat.id, newest.telegramMessageId);
      }

      // Re-read from the database rather than using `fetched`, so a chain can span
      // the overlap boundary and include messages ingested by an earlier run.
      const windowMessages = await listMessagesForChat(db, chat.id, since);
      const idByTelegramId = new Map(
        windowMessages.map((message) => [message.telegramMessageId, message.id]),
      );

      for (const chain of assembleChains(windowMessages, chat.telegramChatId)) {
        const candidates = await parser.parseChain(chain, {
          deviceTimezone: target.deviceTimezone,
          now: now().toISOString(),
        });

        for (const parsedCandidate of candidates) {
          const categories = await classifier.classify({
            title: parsedCandidate.title,
            description: parsedCandidate.description,
            locationName: parsedCandidate.locationName,
            sourceLabel: chat.title,
            evidenceText: parsedCandidate.evidence.map((item) => item.normalizedText).join("\n"),
          });
          const candidate = { ...parsedCandidate, categories };
          const rawMessageIds = chain.messages
            .map((message) => idByTelegramId.get(message.telegramMessageId))
            .filter((id): id is string => Boolean(id));
          if (rawMessageIds.length === 0) continue;

          const saved = await saveCandidate(db, target.userId, candidate, rawMessageIds);
          if (saved.skipped) continue; // the user dismissed this evidence before
          result.candidatesWritten += 1;

          // Only a confirmed candidate with a trusted absolute date becomes an event.
          if (candidate.status === "confirmed" && candidate.eventDate && candidate.title) {
            await upsertCalendarEvent(db, saved.id, target.userId, {
              title: candidate.title,
              description: candidate.description,
              eventDate: candidate.eventDate,
              startAt: candidate.startAt,
              endAt: candidate.endAt,
              timezone: candidate.timezone,
              allDay: candidate.allDay,
              locationName: candidate.locationName,
              address: candidate.address,
              rsvpUrl: candidate.rsvpUrl,
              directionsChannel: candidate.directionsChannel,
              sourceLabel: chat.title,
              categories: candidate.categories,
            });
            result.eventsWritten += 1;
          }
        }
      }
    }

    await finishSyncRun(db, runId, "completed");
    return result;
  } catch (error) {
    // A dead session is a state to record, not a crash to swallow silently.
    if (error instanceof ReauthRequiredError) {
      await markConnectionStatus(db, target.connectionId, "reauth_required");
      await finishSyncRun(db, runId, "failed", "reauth_required");
      return { ...result, status: "failed", errorCode: "reauth_required" };
    }

    const errorCode = error instanceof FloodWaitError ? "rate_limited" : "sync_failed";
    await finishSyncRun(db, runId, "failed", errorCode);
    log("sync run failed", { runId, errorCode });
    return { ...result, status: "failed", errorCode };
  }
}

/**
 * Telegram answers a rate limit with "wait N seconds". Honour it rather than
 * retrying blindly, and give up after a few attempts so a run cannot hang forever.
 */
async function withFloodRetry<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof FloodWaitError) || attempt >= MAX_FLOOD_RETRIES) throw error;
      log("rate limited by Telegram; backing off", {
        seconds: error.seconds,
        attempt: attempt + 1,
      });
      await sleep(error.seconds * 1000);
    }
  }
}
