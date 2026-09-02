import type { FakeTelegramData } from "../telegram/fake.js";

/**
 * STAND-IN for `fixtures/noc-sharing.input.json`, which Person B owns and has not
 * shipped yet (only the expected output exists). Shaped to produce exactly the
 * candidate described in `fixtures/noc-sharing.expected.json`.
 *
 * Delete this and read the shared fixture once Person B lands it.
 */

export const CHAT_START_IT = {
  telegramChatId: "-1001111111111",
  title: "NUS Start IT",
  username: "nusstartit",
};

export const CHAT_CAREERS = {
  telegramChatId: "-1002222222222",
  title: "Careers Board",
  username: "careersboard",
};

const SENT_AT = new Date("2025-08-25T02:00:00.000Z");

/** Timed event with a full date, time range, venue and RSVP link. */
export const NOC_MESSAGE = {
  telegramMessageId: "1001",
  sentAt: SENT_AT,
  rawText: [
    "NOC sharing",
    "📅 2 Sep, 4pm - 6pm",
    "📍 NUS Enterprise I3 MPH, Level 2, 21 Heng Mui Keng Terrace, Singapore 119613",
    "RSVP here",
    "Follow @nusstartit for directions",
  ].join("\n"),
  entities: [
    {
      label: "RSVP here",
      url: "https://forms.cloud.microsoft/r/0YVwa8YMEy",
      offset: 0,
      length: 9,
    },
  ],
  replyToMessageId: null,
};

/** A date with no time must become an all-day event. */
export const DATE_ONLY_MESSAGE = {
  telegramMessageId: "1002",
  sentAt: SENT_AT,
  rawText: ["Career fair", "📅 15 Sep", "📍 University Town"].join("\n"),
  entities: [],
  replyToMessageId: null,
};

/** No date at all must stay unconfirmed and never become a calendar event. */
export const NO_DATE_MESSAGE = {
  telegramMessageId: "1003",
  sentAt: SENT_AT,
  rawText: "We are hiring interns. DM us if interested.",
  entities: [],
  replyToMessageId: null,
};

/** A follow-up reply, so chain assembly is exercised. */
export const FOLLOW_UP_MESSAGE = {
  telegramMessageId: "1004",
  sentAt: new Date("2025-08-26T02:00:00.000Z"),
  rawText: "Reminder: seats are limited!",
  entities: [],
  replyToMessageId: "1001",
};

export function fakeTelegramData(): FakeTelegramData {
  return {
    folders: [
      { id: 2, title: "Opportunities" },
      { id: 3, title: "Personal" },
    ],
    chatsByFolder: {
      2: [CHAT_START_IT, CHAT_CAREERS],
      3: [],
    },
    messagesByChat: {
      [CHAT_START_IT.telegramChatId]: [NOC_MESSAGE, FOLLOW_UP_MESSAGE],
      [CHAT_CAREERS.telegramChatId]: [DATE_ONLY_MESSAGE, NO_DATE_MESSAGE],
    },
  };
}

export const SYNC_NOW = new Date("2025-08-27T02:00:00.000Z");
