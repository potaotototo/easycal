import type {
  FetchMessagesOptions,
  TelegramChat,
  TelegramFolder,
  TelegramMessage,
  TelegramPort,
} from "./port.js";

export interface FakeTelegramData {
  folders: TelegramFolder[];
  /** Chats per folder id. Change this between runs to simulate a dynamic folder. */
  chatsByFolder: Record<number, TelegramChat[]>;
  /** Messages per telegramChatId. */
  messagesByChat: Record<string, TelegramMessage[]>;
}

/**
 * In-memory Telegram used by every test and by the acceptance check, so the whole
 * pipeline can be verified without a live account or network.
 */
export class FakeTelegramPort implements TelegramPort {
  readonly calls = { listFolders: 0, resolveFolderChats: 0, fetchMessages: 0 };
  #disconnected = false;

  constructor(private data: FakeTelegramData) {}

  /** Lets a test simulate the folder membership changing between runs. */
  setData(data: FakeTelegramData): void {
    this.data = data;
  }

  async listFolders(): Promise<TelegramFolder[]> {
    this.calls.listFolders += 1;
    return this.data.folders;
  }

  async resolveFolderChats(folderId: number): Promise<TelegramChat[]> {
    this.calls.resolveFolderChats += 1;
    return this.data.chatsByFolder[folderId] ?? [];
  }

  async fetchMessages(
    chat: TelegramChat,
    options: FetchMessagesOptions,
  ): Promise<TelegramMessage[]> {
    this.calls.fetchMessages += 1;
    const all = this.data.messagesByChat[chat.telegramChatId] ?? [];
    const minId = options.minMessageId ? Number(options.minMessageId) : null;
    return all
      .filter((message) => message.sentAt >= options.since)
      .filter((message) => minId === null || Number(message.telegramMessageId) > minId)
      .sort((a, b) => Number(a.telegramMessageId) - Number(b.telegramMessageId))
      .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER);
  }

  async disconnect(): Promise<void> {
    this.#disconnected = true;
  }

  get disconnected(): boolean {
    return this.#disconnected;
  }
}
