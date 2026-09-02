import type { MessageEvidence } from "../../contracts/src/event.js";
import { normalizeTelegramMessage } from "./normalizer.js";
import type { RawTelegramMessage } from "./types.js";

const EVENT_SIGNAL = /(?:📅|🗓|⏰|📍|\b(?:date|time|venue|location|rsvp|register|sign\s*up)\b|https?:\/\/)/i;

export function assembleMessageChain(
  messages: RawTelegramMessage[],
  seedMessageId: string,
  proximityMinutes = 15,
): MessageEvidence[] {
  const seed = messages.find((message) => message.telegramMessageId === seedMessageId);
  if (!seed) throw new Error(`Unknown seed message: ${seedMessageId}`);

  const sameChat = messages.filter((message) => message.telegramChatId === seed.telegramChatId);
  const included = new Set<string>([seed.telegramMessageId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const message of sameChat) {
      const connectsToIncluded =
        (message.replyToMessageId && included.has(message.replyToMessageId)) ||
        (message.replyToMessageId &&
          included.has(message.telegramMessageId) &&
          sameChat.some((candidate) => candidate.telegramMessageId === message.replyToMessageId));
      if (connectsToIncluded && !included.has(message.telegramMessageId)) {
        included.add(message.telegramMessageId);
        changed = true;
      }
      if (included.has(message.telegramMessageId) && message.replyToMessageId && !included.has(message.replyToMessageId)) {
        included.add(message.replyToMessageId);
        changed = true;
      }
    }
  }

  const seedTime = Date.parse(seed.sentAt);
  for (const message of sameChat) {
    const distance = Math.abs(Date.parse(message.sentAt) - seedTime);
    if (distance <= proximityMinutes * 60_000 && EVENT_SIGNAL.test(message.text)) {
      included.add(message.telegramMessageId);
    }
  }

  return sameChat
    .filter((message) => included.has(message.telegramMessageId))
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))
    .map(normalizeTelegramMessage);
}
