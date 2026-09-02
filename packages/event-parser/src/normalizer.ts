import type { LinkEntity, MessageEvidence } from "../../contracts/src/event.js";
import type { RawTelegramMessage } from "./types.js";

const SAFE_URL = /^https?:\/\//i;

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function normalizeReadableText(raw: string): string {
  return decodeEntities(raw)
    .replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
    .replace(/<\/?(?:b|strong|i|em|u|s|code|pre|blockquote)\b[^>]*>/gi, "")
    .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/gi, "$1")
    .replace(/[*_~`]+/g, "")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function entityLinks(message: RawTelegramMessage): LinkEntity[] {
  return (message.entities ?? []).flatMap((entity) => {
    const label = message.text.slice(entity.offset, entity.offset + entity.length);
    const url = entity.type === "text_link" ? entity.url : label;
    if (!url || !SAFE_URL.test(url)) return [];
    return [{ label, url, offset: entity.offset, length: entity.length }];
  });
}

function inlineLinks(raw: string, normalized: string): LinkEntity[] {
  const links: LinkEntity[] = [];
  const markdown = /\[([^\]]+)]\((https?:\/\/[^)]+)\)/gi;
  const plain = /https?:\/\/[^\s<>]+/gi;

  for (const match of raw.matchAll(markdown)) {
    const label = match[1] ?? match[2] ?? "link";
    const url = match[2];
    if (url) {
      links.push({ label, url, offset: Math.max(0, normalized.indexOf(label)), length: label.length });
    }
  }

  for (const match of raw.matchAll(plain)) {
    const url = match[0].replace(/[),.;!?]+$/, "");
    links.push({ label: url, url, offset: Math.max(0, normalized.indexOf(url)), length: url.length });
  }
  return links;
}

export function normalizeTelegramMessage(message: RawTelegramMessage): MessageEvidence {
  const normalizedText = normalizeReadableText(message.text);
  const links = [...entityLinks(message), ...inlineLinks(message.text, normalizedText)]
    .filter((link, index, all) => all.findIndex((candidate) => candidate.url === link.url) === index)
    .sort((a, b) => a.offset - b.offset);

  return {
    telegramChatId: message.telegramChatId,
    telegramMessageId: message.telegramMessageId,
    sentAt: message.sentAt,
    normalizedText,
    links,
  };
}
