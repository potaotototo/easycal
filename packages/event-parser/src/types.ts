export type TelegramEntityType = "text_link" | "url";

export interface TelegramTextEntity {
  type: TelegramEntityType;
  offset: number;
  length: number;
  url?: string;
}

export interface RawTelegramMessage {
  telegramChatId: string;
  telegramMessageId: string;
  sentAt: string;
  text: string;
  entities?: TelegramTextEntity[];
  replyToMessageId?: string | null;
}

export interface ParserOptions {
  defaultTimezone?: string;
  proximityMinutes?: number;
}

export type StructuredModelFallback = (input: {
  evidence: import("../../contracts/src/event.js").MessageEvidence[];
}) => Promise<unknown>;
