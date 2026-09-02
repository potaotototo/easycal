/**
 * The seam between our sync logic and Telegram.
 *
 * Everything above this interface is testable without a network or a real account:
 * `GramJsTelegramPort` talks to Telegram, `FakeTelegramPort` replays fixtures, and
 * the sync engine cannot tell them apart.
 */

export interface TelegramFolder {
  id: number;
  title: string;
}

export interface TelegramChat {
  telegramChatId: string;
  title: string;
  username: string | null;
}

export interface TelegramLinkEntity {
  label: string;
  url: string;
  offset: number;
  length: number;
}

export interface TelegramMessage {
  telegramMessageId: string;
  sentAt: Date;
  rawText: string;
  entities: TelegramLinkEntity[];
  replyToMessageId: string | null;
}

export interface FetchMessagesOptions {
  /** Start of the sync window: lookback days plus the configured overlap. */
  since: Date;
  /** Cursor from the previous run; only strictly newer messages are returned. */
  minMessageId?: string | null;
  limit?: number;
}

export interface TelegramPort {
  /** Folders are Telegram "dialog filters" — the user picks one of these. */
  listFolders(): Promise<TelegramFolder[]>;

  /**
   * Resolves a folder to the chats it currently contains. Called on every sync run,
   * because the folder is a live filter: newly joined or newly muted channels must
   * start being included without the user reselecting anything.
   */
  resolveFolderChats(folderId: number): Promise<TelegramChat[]>;

  fetchMessages(chat: TelegramChat, options: FetchMessagesOptions): Promise<TelegramMessage[]>;

  disconnect(): Promise<void>;
}

/** Raised when Telegram asks us to back off; the sync loop waits and retries. */
export class FloodWaitError extends Error {
  constructor(readonly seconds: number) {
    super(`Telegram asked us to wait ${seconds}s`);
    this.name = "FloodWaitError";
  }
}

/** Raised when the stored session is no longer usable and the user must re-authorize. */
export class ReauthRequiredError extends Error {
  constructor(cause?: string) {
    super(`Telegram connection needs reauthorization${cause ? `: ${cause}` : ""}`);
    this.name = "ReauthRequiredError";
  }
}

/**
 * Telegram delivers text and formatting separately, so "normalizing" is mostly
 * whitespace tidying — there is no inline markup to strip. Person B's normalizer
 * (workstreams B1) can supersede this; link entities are already preserved
 * structurally by `TelegramMessage.entities`.
 */
export function normalizeText(rawText: string): string {
  return rawText
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}
