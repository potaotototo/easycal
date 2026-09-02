import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import {
  FloodWaitError,
  ReauthRequiredError,
  type FetchMessagesOptions,
  type TelegramChat,
  type TelegramFolder,
  type TelegramLinkEntity,
  type TelegramMessage,
  type TelegramPort,
} from "./port.js";

export interface GramJsCredentials {
  apiId: number;
  apiHash: string;
}

export async function createClient(
  credentials: GramJsCredentials,
  sessionString = "",
): Promise<TelegramClient> {
  const client = new TelegramClient(
    new StringSession(sessionString),
    credentials.apiId,
    credentials.apiHash,
    { connectionRetries: 3, autoReconnect: true },
  );
  await client.connect();
  return client;
}

/** Real Telegram access for the sync worker. */
export class GramJsTelegramPort implements TelegramPort {
  constructor(private readonly client: TelegramClient) {}

  async listFolders(): Promise<TelegramFolder[]> {
    const result = await this.invoke(() =>
      this.client.invoke(new Api.messages.GetDialogFilters()),
    );
    return result.filters.flatMap((filter) =>
      filter instanceof Api.DialogFilter ? [{ id: filter.id, title: titleOf(filter) }] : [],
    );
  }

  async resolveFolderChats(folderId: number): Promise<TelegramChat[]> {
    const result = await this.invoke(() =>
      this.client.invoke(new Api.messages.GetDialogFilters()),
    );
    const filter = result.filters.find(
      (candidate): candidate is Api.DialogFilter =>
        candidate instanceof Api.DialogFilter && candidate.id === folderId,
    );
    if (!filter) return [];

    const included = new Set(
      [...filter.pinnedPeers, ...filter.includePeers].map(peerKey).filter(Boolean),
    );
    const excluded = new Set(filter.excludePeers.map(peerKey).filter(Boolean));

    // The folder is a live filter: resolve it against current dialogs on every run so
    // channels joined since the last sync are picked up without user action.
    const dialogs = await this.invoke(() => this.client.getDialogs({ limit: undefined }));
    const chats: TelegramChat[] = [];

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (!entity) continue;
      const key = entityKey(entity);
      if (!key || excluded.has(key)) continue;

      if (included.has(key) || matchesCategory(filter, dialog)) {
        chats.push({
          telegramChatId: String(entity.id),
          title: dialog.title ?? "(untitled)",
          username: "username" in entity ? ((entity.username as string | undefined) ?? null) : null,
        });
      }
    }

    return dedupeByChatId(chats);
  }

  async fetchMessages(
    chat: TelegramChat,
    options: FetchMessagesOptions,
  ): Promise<TelegramMessage[]> {
    const messages: TelegramMessage[] = [];
    const minId = options.minMessageId ? Number(options.minMessageId) : 0;

    await this.invoke(async () => {
      const iterator = this.client.iterMessages(chat.telegramChatId, {
        reverse: true, // oldest first, so the cursor advances monotonically
        offsetDate: Math.floor(options.since.getTime() / 1000),
        ...(minId > 0 ? { minId } : {}),
        limit: options.limit,
      });

      for await (const message of iterator) {
        if (!message.date) continue;
        const sentAt = new Date(message.date * 1000);
        // The iterator's date offset is coarse; enforce the window ourselves.
        if (sentAt < options.since) continue;
        const rawText = message.message ?? "";
        if (!rawText.trim()) continue;

        messages.push({
          telegramMessageId: String(message.id),
          sentAt,
          rawText,
          entities: extractLinkEntities(rawText, message.entities ?? []),
          replyToMessageId: message.replyTo?.replyToMsgId
            ? String(message.replyTo.replyToMsgId)
            : null,
        });
      }
    });

    return messages;
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  /**
   * Translates Telegram's error vocabulary into ours: rate limits become a typed
   * backoff signal, and dead sessions become a reauth signal so the connection is
   * flagged rather than failing silently (docs/architecture.md).
   */
  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const flood = /FLOOD_WAIT_(\d+)/.exec(message);
      if (flood?.[1]) throw new FloodWaitError(Number(flood[1]));

      if (/AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|UNAUTHORIZED/i.test(message)) {
        throw new ReauthRequiredError(message);
      }
      throw error;
    }
  }
}

/** Newer layers wrap a filter title in TextWithEntities; older ones use a plain string. */
function titleOf(filter: Api.DialogFilter): string {
  const title = filter.title as unknown;
  if (typeof title === "string") return title;
  if (title && typeof title === "object" && "text" in title) {
    return String((title as { text: unknown }).text);
  }
  return `Folder ${filter.id}`;
}

function peerKey(peer: Api.TypeInputPeer): string {
  if (peer instanceof Api.InputPeerChannel) return `channel:${peer.channelId}`;
  if (peer instanceof Api.InputPeerChat) return `chat:${peer.chatId}`;
  if (peer instanceof Api.InputPeerUser) return `user:${peer.userId}`;
  return "";
}

function entityKey(entity: { className?: string; id: unknown }): string {
  switch (entity.className) {
    case "Channel":
    case "ChannelForbidden":
      return `channel:${entity.id}`;
    case "Chat":
    case "ChatForbidden":
      return `chat:${entity.id}`;
    case "User":
      return `user:${entity.id}`;
    default:
      return "";
  }
}

/** Mirrors the folder's category flags (groups / channels / bots / contacts). */
function matchesCategory(filter: Api.DialogFilter, dialog: { isChannel?: boolean; isGroup?: boolean; isUser?: boolean; entity?: unknown }): boolean {
  const entity = dialog.entity as { broadcast?: boolean; bot?: boolean } | undefined;
  if (filter.broadcasts && entity?.broadcast) return true;
  if (filter.groups && dialog.isGroup) return true;
  if (filter.bots && entity?.bot) return true;
  if ((filter.contacts || filter.nonContacts) && dialog.isUser) return true;
  return false;
}

function dedupeByChatId(chats: TelegramChat[]): TelegramChat[] {
  const seen = new Map<string, TelegramChat>();
  for (const chat of chats) seen.set(chat.telegramChatId, chat);
  return [...seen.values()];
}

/**
 * Keeps link entities as `{ label, url, offset, length }` so the parser can find an
 * RSVP URL even when the text shows only "sign up here".
 */
export function extractLinkEntities(
  text: string,
  entities: Api.TypeMessageEntity[],
): TelegramLinkEntity[] {
  const links: TelegramLinkEntity[] = [];
  for (const entity of entities) {
    const label = text.slice(entity.offset, entity.offset + entity.length);
    if (entity instanceof Api.MessageEntityTextUrl) {
      links.push({ label, url: entity.url, offset: entity.offset, length: entity.length });
    } else if (entity instanceof Api.MessageEntityUrl) {
      links.push({ label, url: label, offset: entity.offset, length: entity.length });
    }
  }
  return links;
}
