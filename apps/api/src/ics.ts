import type { CalendarEvent } from "@easycal/contracts/event";

/**
 * Minimal RFC 5545 writer.
 *
 * Hand-rolled rather than pulled from a library so the output is deterministic and
 * snapshot-testable: timed events are emitted in UTC (no VTIMEZONE to ship), and a
 * date without a time becomes a true all-day event, which is the product rule.
 */

const PRODID = "-//EasyCal//EN";
const CRLF = "\r\n";

export interface IcsOptions {
  calendarName?: string;
  /** Fixed clock for tests; defaults to now. */
  dtstamp?: Date;
}

export function buildIcs(events: CalendarEvent[], options: IcsOptions = {}): string {
  const dtstamp = formatUtc(options.dtstamp ?? new Date());

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  if (options.calendarName) {
    lines.push(`X-WR-CALNAME:${escapeText(options.calendarName)}`);
  }

  for (const event of events) {
    lines.push(...buildEvent(event, dtstamp));
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

function buildEvent(event: CalendarEvent, dtstamp: string): string[] {
  const lines = ["BEGIN:VEVENT", `UID:${event.id}@easycal`, `DTSTAMP:${dtstamp}`];

  if (event.allDay) {
    // DTEND is exclusive for all-day events, so it is the following day.
    lines.push(`DTSTART;VALUE=DATE:${compactDate(event.eventDate)}`);
    lines.push(`DTEND;VALUE=DATE:${compactDate(addOneDay(event.eventDate))}`);
  } else if (event.startAt) {
    lines.push(`DTSTART:${formatUtc(new Date(event.startAt))}`);
    if (event.endAt) lines.push(`DTEND:${formatUtc(new Date(event.endAt))}`);
  } else {
    // Defensive: a non-all-day event without a start cannot be represented.
    lines.push(`DTSTART;VALUE=DATE:${compactDate(event.eventDate)}`);
  }

  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);

  const location = [event.locationName, event.address].filter(Boolean).join(", ");
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  if (event.rsvpUrl) lines.push(`URL:${escapeText(event.rsvpUrl)}`);

  lines.push("END:VEVENT");
  return lines;
}

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newline are special. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function formatUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

function compactDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

function addOneDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * RFC 5545 §3.1: lines are folded at 75 octets, continuations starting with a space.
 * Folding counts bytes, not characters, so multi-byte text is measured correctly.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  let limit = 75;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Do not split a multi-byte character: back off to a lead byte.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }

  return parts.join(`${CRLF} `);
}
