import type { EventCandidate, MessageEvidence } from "../../contracts/src/event.js";
import type { ParserOptions, StructuredModelFallback } from "./types.js";
import { validateStructuredCandidate } from "./validate.js";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function inferYear(month: number, day: number, sentAt: string): number {
  const source = new Date(sentAt);
  let year = source.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  if (candidate < source.getTime() - 180 * 86_400_000) year += 1;
  return year;
}

function extractDate(text: string, sentAt: string): string | null {
  const dayFirst = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*,?\s*(\d{4}))?\b/i);
  const monthFirst = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/i);
  let day: number;
  let month: number;
  let year: number;

  if (dayFirst) {
    day = Number(dayFirst[1]);
    month = MONTHS[dayFirst[2]!.toLowerCase()] ?? 0;
    year = dayFirst[3] ? Number(dayFirst[3]) : inferYear(month, day, sentAt);
  } else if (monthFirst) {
    month = MONTHS[monthFirst[1]!.toLowerCase()] ?? 0;
    day = Number(monthFirst[2]);
    year = monthFirst[3] ? Number(monthFirst[3]) : inferYear(month, day, sentAt);
  } else {
    return null;
  }

  return validDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
}

interface ParsedTime { hour: number; minute: number }

function clock(hourText: string, minuteText: string | undefined, meridiem: string | undefined): ParsedTime | null {
  let hour = Number(hourText);
  const minute = Number(minuteText ?? "0");
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem.toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (meridiem.toLowerCase() === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

function extractTimes(text: string): { start: ParsedTime; end: ParsedTime | null } | null {
  const range = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (range) {
    const sharedMeridiem = range[3] ?? range[6];
    const start = clock(range[1]!, range[2], sharedMeridiem);
    const end = clock(range[4]!, range[5], range[6] ?? range[3]);
    return start && end ? { start, end } : null;
  }
  const single = text.match(/(?:\bat\b|\btime\s*[:\-])\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const start = single ? clock(single[1]!, single[2], single[3]) : null;
  return start ? { start, end: null } : null;
}

function timezoneFor(text: string, fallback: string): string {
  return /\b(?:singapore|sgt)\b|\b\d{6}\b/i.test(text) ? "Asia/Singapore" : fallback;
}

function offsetFor(timezone: string): string {
  return timezone === "Asia/Singapore" ? "+08:00" : "Z";
}

function instant(eventDate: string, time: ParsedTime, timezone: string): string {
  return `${eventDate}T${pad(time.hour)}:${pad(time.minute)}:00${offsetFor(timezone)}`;
}

function cleanLabel(line: string): string {
  return line.replace(/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+/gu, "").trim();
}

function extractTitle(lines: string[]): string | null {
  const labeled = lines.find((line) => /^(?:event|title)\s*[:\-]/i.test(cleanLabel(line)));
  if (labeled) return cleanLabel(labeled).replace(/^(?:event|title)\s*[:\-]\s*/i, "").trim() || null;
  const ignored = /^(?:date|time|when|venue|location|where|rsvp|register|sign\s*up|directions?)\b/i;
  const first = lines.map(cleanLabel).find((line) => line.length >= 3 && line.length <= 120 && !ignored.test(line) && !/^https?:\/\//i.test(line));
  return first ?? null;
}

function extractLocation(lines: string[]): { locationName: string | null; address: string | null } {
  const index = lines.findIndex((line) => /^(?:📍\s*)?(?:venue|location|where)?\s*[:\-]?\s*\S/i.test(line) && /(?:📍|venue|location|where)/i.test(line));
  if (index < 0) return { locationName: null, address: null };
  const locationName = lines[index]!
    .replace(/^\s*📍\s*/, "")
    .replace(/^(?:venue|location|where)\s*[:\-]\s*/i, "")
    .trim() || null;
  const following = lines[index + 1]?.trim() ?? "";
  const address = /\d.+(?:street|st\b|road|rd\b|avenue|ave\b|terrace|drive|singapore|\d{6})/i.test(following)
    ? following
    : null;
  return { locationName, address };
}

function extractRsvp(evidence: MessageEvidence[]): string | null {
  const text = evidence.map((item) => item.normalizedText).join("\n");
  const preferred = evidence.flatMap((item) => item.links).find((link) => {
    const position = text.indexOf(link.label);
    const context = text.slice(Math.max(0, position - 30), position + link.label.length + 30);
    return /rsvp|register|sign\s*up|apply/i.test(`${link.label} ${context}`);
  });
  return preferred?.url ?? evidence.flatMap((item) => item.links)[0]?.url ?? null;
}

export function extractDeterministicEvent(
  evidence: MessageEvidence[],
  options: ParserOptions = {},
): EventCandidate {
  if (evidence.length === 0) throw new Error("At least one evidence message is required");
  const combined = evidence.map((item) => item.normalizedText).join("\n");
  const lines = combined.split("\n").map((line) => line.trim()).filter(Boolean);
  const sourceTime = evidence[0]!.sentAt;
  const eventDate = extractDate(combined, sourceTime);
  const parsedTimes = extractTimes(combined);
  const title = extractTitle(lines);
  const { locationName, address } = extractLocation(lines);
  const timezone = timezoneFor(combined, options.defaultTimezone ?? "UTC");
  const rsvpUrl = extractRsvp(evidence);
  const directionsChannel = combined.match(/directions?(?:\s+channel)?\s*[:\-]\s*(@[a-z0-9_]+)/i)?.[1] ?? null;
  const confirmed = Boolean(eventDate && title);
  const allDay = Boolean(eventDate && !parsedTimes);
  const startAt = eventDate && parsedTimes ? instant(eventDate, parsedTimes.start, timezone) : null;
  const endAt = eventDate && parsedTimes?.end ? instant(eventDate, parsedTimes.end, timezone) : null;
  const signals = [eventDate, title, parsedTimes, locationName, rsvpUrl].filter(Boolean).length;
  const reviewReasons: string[] = [];
  if (!eventDate) reviewReasons.push("No trusted absolute event date was found");
  if (!title) reviewReasons.push("No event title was found");
  if (eventDate && !parsedTimes) reviewReasons.push("No time was found; treating this as an all-day event");
  if (!rsvpUrl) reviewReasons.push("No RSVP URL was found");

  return {
    id: `telegram:${evidence[0]!.telegramChatId}:${evidence[0]!.telegramMessageId}`,
    status: confirmed ? "confirmed" : "unconfirmed",
    confidence: confirmed && signals >= 5 ? "high" : confirmed ? "medium" : "low",
    title,
    description: combined,
    startAt,
    endAt,
    eventDate,
    timezone: eventDate ? timezone : null,
    allDay,
    locationName,
    address,
    rsvpUrl,
    directionsChannel,
    evidence,
    reviewReasons,
  };
}

export async function parseEvent(
  evidence: MessageEvidence[],
  options: ParserOptions = {},
  fallback?: StructuredModelFallback,
): Promise<EventCandidate> {
  const deterministic = extractDeterministicEvent(evidence, options);
  if (deterministic.status === "confirmed" || !fallback) return deterministic;
  const modelOutput = await fallback({ evidence });
  return validateStructuredCandidate(modelOutput, evidence) ?? deterministic;
}
