import { randomUUID } from "node:crypto";
import type { Confidence, EventCandidate } from "@easycal/contracts/event";
import type { EventParser, MessageChain, ParseContext } from "./contract.js";

/**
 * A STAND-IN for Person B's parser (`packages/event-parser`), so the worker's
 * persistence path can be built and tested before that package exists.
 *
 * It implements only the deterministic first pass described in
 * docs/architecture.md — marker/regex extraction, no model fallback — and is
 * deliberately conservative: without a trusted absolute date a candidate stays
 * `unconfirmed` rather than inventing one.
 */
export class StubEventParser implements EventParser {
  async parseChain(chain: MessageChain, context: ParseContext): Promise<EventCandidate[]> {
    const text = chain.messages.map((message) => message.normalizedText).join("\n");
    const links = chain.messages.flatMap((message) => message.links);
    const sentAt = chain.messages[0]?.sentAt ?? context.now;

    const date = extractDate(text, sentAt);
    const times = extractTimeRange(text);
    const reviewReasons: string[] = [];

    if (!date) reviewReasons.push("no absolute date found");
    if (date && !times) reviewReasons.push("date without a time; treated as all-day");

    const allDay = Boolean(date) && !times;
    const timezone = date ? context.deviceTimezone : null;

    const confidence: Confidence = !date ? "low" : times ? "high" : "medium";
    const status = date ? "confirmed" : "unconfirmed";

    const candidate: EventCandidate = {
      id: randomUUID(),
      status,
      confidence,
      title: extractTitle(chain.messages[0]?.normalizedText ?? ""),
      // Deliberately null: `description` is published in share snapshots, so
      // copying the message body here would leak private evidence into a public
      // link. A real parser should write a summary it authored, never the source
      // text. See the note in apps/worker/README.md for Person B.
      description: null,
      eventDate: date,
      startAt: date && times ? zonedIso(date, times.start, context.deviceTimezone) : null,
      endAt: date && times?.end ? zonedIso(date, times.end, context.deviceTimezone) : null,
      timezone,
      allDay,
      locationName: extractMarked(text, "📍"),
      address: extractAddress(text),
      rsvpUrl: extractRsvpUrl(links, text),
      directionsChannel: extractChannelHandle(text),
      evidence: chain.messages,
      reviewReasons,
    };

    return [candidate];
  }
}

/**
 * Builds a timezone-aware ISO timestamp. Without the offset the string would be a
 * naive local time, and Postgres would read it as UTC when writing to timestamptz —
 * silently shifting every event by the zone's offset.
 */
export function zonedIso(date: string, time: string, timeZone: string): string {
  return `${date}T${time}:00${offsetFor(date, time, timeZone)}`;
}

function offsetFor(date: string, time: string, timeZone: string): string {
  // Resolve the offset that applies at that wall-clock moment, so DST is respected.
  const approximate = new Date(`${date}T${time}:00Z`);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  const name = formatter
    .formatToParts(approximate)
    .find((part) => part.type === "timeZoneName")?.value;

  const match = /GMT([+-]\d{2}:\d{2})/.exec(name ?? "");
  return match?.[1] ?? "Z";
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Resolves the year from the message's sent time when the text omits it, and
 * rejects dates implausibly far from it (docs/architecture.md, "Parsing rules").
 */
export function extractDate(text: string, sentAtIso: string): string | null {
  const sentAt = new Date(sentAtIso);

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return plausible(`${iso[1]}-${iso[2]}-${iso[3]}`, sentAt);

  const dayMonth = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{4})?/i
    .exec(text);
  if (dayMonth?.[1] && dayMonth[2]) {
    const month = MONTHS[dayMonth[2].toLowerCase()]!;
    const year = dayMonth[3] ? Number(dayMonth[3]) : yearFor(month, Number(dayMonth[1]), sentAt);
    return plausible(format(year, month, Number(dayMonth[1])), sentAt);
  }

  const monthDay = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/i
    .exec(text);
  if (monthDay?.[1] && monthDay[2]) {
    const month = MONTHS[monthDay[1].toLowerCase()]!;
    const year = monthDay[3] ? Number(monthDay[3]) : yearFor(month, Number(monthDay[2]), sentAt);
    return plausible(format(year, month, Number(monthDay[2])), sentAt);
  }

  return null;
}

/** Picks the year that puts the date nearest the message, preferring the future. */
function yearFor(month: number, day: number, sentAt: Date): number {
  const sentYear = sentAt.getUTCFullYear();
  const sameYear = Date.UTC(sentYear, month - 1, day);
  // A date more than a month before the message probably means next year.
  return sameYear < sentAt.getTime() - 31 * 24 * 3600 * 1000 ? sentYear + 1 : sentYear;
}

function format(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Rejects anything more than a year either side of the message's sent time. */
function plausible(date: string, sentAt: Date): string | null {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  const yearMs = 365 * 24 * 3600 * 1000;
  if (parsed < sentAt.getTime() - yearMs || parsed > sentAt.getTime() + yearMs) return null;
  return date;
}

export function extractTimeRange(text: string): { start: string; end: string | null } | null {
  const range =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i
      .exec(text);
  if (range) {
    const endMeridiem = range[6]?.toLowerCase();
    const startMeridiem = range[3]?.toLowerCase() ?? endMeridiem;
    const start = to24h(Number(range[1]), range[2], startMeridiem);
    const end = to24h(Number(range[4]), range[5], endMeridiem);
    if (start) return { start, end };
  }

  const single = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))\s*(am|pm)?/i.exec(text);
  if (single?.[1]) {
    const start = to24h(Number(single[1]), single[2], single[3]?.toLowerCase());
    if (start) return { start, end: null };
  }
  return null;
}

function to24h(hour: number, minutes: string | undefined, meridiem: string | undefined): string | null {
  let h = hour;
  if (meridiem === "pm" && h < 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${minutes ?? "00"}`;
}

function extractTitle(firstMessage: string): string | null {
  const line = firstMessage
    .split("\n")
    .map((candidate) => candidate.replace(/^[^\p{L}\p{N}]+/u, "").trim())
    .find((candidate) => candidate.length > 2);
  return line ? line.slice(0, 200) : null;
}

function extractMarked(text: string, marker: string): string | null {
  for (const line of text.split("\n")) {
    if (line.includes(marker)) {
      const value = line.slice(line.indexOf(marker) + marker.length).trim();
      // A venue line often reads "Venue, 123 Some Road" — keep the venue part.
      const [venue] = value.split(/,\s*(?=\d)/);
      if (venue?.trim()) return venue.trim();
    }
  }
  return null;
}

function extractAddress(text: string): string | null {
  const match = /\b\d+[^\n,]*(?:Road|Rd|Street|St|Avenue|Ave|Terrace|Drive|Lane|Way|Blvd)[^\n]*/i
    .exec(text);
  return match ? match[0].trim() : null;
}

function extractRsvpUrl(
  links: Array<{ label: string; url: string }>,
  text: string,
): string | null {
  const rsvpish = /rsvp|sign\s*up|register|tickets?/i;
  const labelled = links.find((link) => rsvpish.test(link.label));
  if (labelled) return labelled.url;

  const nearMarker = links.find((link) => {
    const index = text.toLowerCase().indexOf(link.url.toLowerCase());
    return index >= 0 && rsvpish.test(text.slice(Math.max(0, index - 60), index));
  });
  if (nearMarker) return nearMarker.url;

  return links[0]?.url ?? null;
}

function extractChannelHandle(text: string): string | null {
  const match = /(^|\s)(@[A-Za-z][A-Za-z0-9_]{3,})/.exec(text);
  return match?.[2] ?? null;
}
