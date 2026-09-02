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
