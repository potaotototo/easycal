import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RawTelegramMessage } from "../src/types.js";
import {
  assembleMessageChain,
  candidateToCalendarEvent,
  extractDeterministicEvent,
  normalizeTelegramMessage,
  validateStructuredCandidate,
} from "../src/index.js";

async function fixture<T>(name: string): Promise<T> {
  const source = await readFile(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8");
  return JSON.parse(source) as T;
}

function expectedYear(value: string, sentAt: string): string {
  return value.replace("YEAR", String(new Date(sentAt).getUTCFullYear()));
}

test("normalizer preserves hidden Telegram links while producing readable text", async () => {
  const [input] = await fixture<RawTelegramMessage[]>("noc-sharing.input.json");
  const evidence = normalizeTelegramMessage(input!);
  assert.equal(evidence.links.length, 1);
  assert.equal(evidence.links[0]?.label, "RSVP here");
  assert.equal(evidence.links[0]?.url, "https://forms.cloud.microsoft/r/0YVwa8YMEy");
  assert.match(evidence.normalizedText, /NOC sharing/);
});

test("NOC fixture produces a high-confidence timed event with the expected RSVP URL", async () => {
  const input = await fixture<RawTelegramMessage[]>("noc-sharing.input.json");
  const expected = await fixture<Record<string, unknown>>("noc-sharing.expected.json");
  const evidence = assembleMessageChain(input, input[0]!.telegramMessageId);
  const candidate = extractDeterministicEvent(evidence, { defaultTimezone: "Asia/Singapore" });

  assert.equal(candidate.status, expected.status);
  assert.equal(candidate.confidence, expected.confidence);
  assert.equal(candidate.title, expected.title);
  assert.equal(candidate.eventDate, expectedYear(String(expected.eventDate), input[0]!.sentAt));
  assert.equal(candidate.startAt, expectedYear(String(expected.startAt), input[0]!.sentAt));
  assert.equal(candidate.endAt, expectedYear(String(expected.endAt), input[0]!.sentAt));
  assert.equal(candidate.timezone, expected.timezone);
  assert.equal(candidate.allDay, expected.allDay);
  assert.equal(candidate.locationName, expected.locationName);
  assert.equal(candidate.address, expected.address);
  assert.equal(candidate.rsvpUrl, expected.rsvpUrl);
  assert.equal(candidate.directionsChannel, expected.directionsChannel);
  assert.equal(candidate.description, null);
  assert.doesNotThrow(() => candidateToCalendarEvent(candidate));
});

test("date-only fixture becomes an all-day event", async () => {
  const input = await fixture<RawTelegramMessage[]>("date-only.input.json");
  const expected = await fixture<Record<string, unknown>>("date-only.expected.json");
  const candidate = extractDeterministicEvent(input.map(normalizeTelegramMessage), {
    defaultTimezone: "Asia/Singapore",
  });

  assert.equal(candidate.status, expected.status);
  assert.equal(candidate.eventDate, expectedYear(String(expected.eventDate), input[0]!.sentAt));
  assert.equal(candidate.allDay, true);
  assert.equal(candidate.startAt, null);
  assert.equal(candidate.endAt, null);
});

test("no-date fixture remains unconfirmed", async () => {
  const input = await fixture<RawTelegramMessage[]>("no-date.input.json");
  const expected = await fixture<Record<string, unknown>>("no-date.expected.json");
  const candidate = extractDeterministicEvent(input.map(normalizeTelegramMessage));
  assert.equal(candidate.status, expected.status);
  assert.equal(candidate.confidence, expected.confidence);
  assert.equal(candidate.eventDate, null);
});

test("model fallback rejects evidence references that are not in the source chain", async () => {
  const input = await fixture<RawTelegramMessage[]>("no-date.input.json");
  const evidence = input.map(normalizeTelegramMessage);
  const invalid = validateStructuredCandidate(
    {
      title: "Invented event",
      eventDate: "2026-10-12",
      allDay: true,
      evidence: [{ telegramChatId: "other", telegramMessageId: "999" }],
    },
    evidence,
  );
  assert.equal(invalid, null);
});

test("validation rejects impossible dates and inconsistent timed ranges", async () => {
  const input = await fixture<RawTelegramMessage[]>("no-date.input.json");
  const evidence = input.map(normalizeTelegramMessage);
  const base = {
    title: "Validated event",
    eventDate: "2026-10-12",
    allDay: false,
    startAt: "2026-10-12T10:00:00Z",
    evidence: [{ telegramChatId: input[0]!.telegramChatId, telegramMessageId: input[0]!.telegramMessageId }],
  };

  assert.equal(validateStructuredCandidate({ ...base, eventDate: "2026-99-99" }, evidence), null);
  assert.equal(validateStructuredCandidate({ ...base, endAt: "not-an-instant" }, evidence), null);
  assert.equal(validateStructuredCandidate({ ...base, endAt: "2026-10-12T09:00:00Z" }, evidence), null);
  assert.equal(validateStructuredCandidate({ ...base, startAt: "2026-10-13T10:00:00Z" }, evidence), null);
});

test("deterministic extraction resolves IANA timezones and overnight ranges", () => {
  const evidence = [normalizeTelegramMessage({
    telegramChatId: "timezone-chat",
    telegramMessageId: "1",
    sentAt: "2026-01-01T12:00:00Z",
    text: "New York meetup\nDate: January 15, 2026\nTime: 10pm-1am",
  })];
  const candidate = extractDeterministicEvent(evidence, { defaultTimezone: "America/New_York" });

  assert.equal(new Date(candidate.startAt!).toISOString(), "2026-01-16T03:00:00.000Z");
  assert.equal(new Date(candidate.endAt!).toISOString(), "2026-01-16T06:00:00.000Z");
  assert.doesNotThrow(() => candidateToCalendarEvent(candidate));
});

test("chain proximity does not merge adjacent complete event announcements", () => {
  const messages: RawTelegramMessage[] = [
    {
      telegramChatId: "events",
      telegramMessageId: "1",
      sentAt: "2026-09-01T10:00:00Z",
      text: "AI meetup\nDate: 2 September\nTime: 7pm",
    },
    {
      telegramChatId: "events",
      telegramMessageId: "2",
      sentAt: "2026-09-01T10:10:00Z",
      text: "Payments meetup\nDate: 3 September\nTime: 6pm",
    },
  ];

  const chain = assembleMessageChain(messages, "1");
  assert.deepEqual(chain.map((item) => item.telegramMessageId), ["1"]);
});
