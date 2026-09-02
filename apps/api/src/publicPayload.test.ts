import type { CalendarEvent } from "@easycal/contracts/event";
import { toPublicPayload } from "@easycal/db";
import { describe, expect, it } from "vitest";

/**
 * The product rule: "The original Telegram message is private evidence; it is never
 * exposed through public sharing." These tests guard the single mapper that every
 * public payload passes through.
 */

const event: CalendarEvent = {
  id: "evt-1",
  title: "NOC sharing",
  description: "Come hear about the NOC programme",
  eventDate: "2025-09-02",
  startAt: "2025-09-02T08:00:00.000Z",
  endAt: "2025-09-02T10:00:00.000Z",
  timezone: "Asia/Singapore",
  allDay: false,
  locationName: "NUS Enterprise I3 MPH, Level 2",
  address: "21 Heng Mui Keng Terrace, Singapore 119613",
  rsvpUrl: "https://forms.cloud.microsoft/r/0YVwa8YMEy",
  sourceLabel: "NUS Start IT",
};

describe("toPublicPayload", () => {
  it("keeps the fields a public snapshot is meant to show", () => {
    const payload = toPublicPayload(event);
    expect(payload.title).toBe("NOC sharing");
    expect(payload.rsvpUrl).toBe("https://forms.cloud.microsoft/r/0YVwa8YMEy");
    expect(payload.locationName).toBe("NUS Enterprise I3 MPH, Level 2");
    expect(payload.allDay).toBe(false);
  });

  it("drops private evidence smuggled in on the input object", () => {
    const contaminated = {
      ...event,
      rawText: "SECRET raw telegram message",
      normalizedText: "SECRET normalized",
      telegramChatId: "-1001234567890",
      telegramMessageId: "4242",
      evidence: [{ normalizedText: "SECRET" }],
      directionsChannel: "@nusstartit",
    } as unknown as CalendarEvent;

    const serialized = JSON.stringify(toPublicPayload(contaminated));

    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("-1001234567890");
    expect(serialized).not.toContain("4242");
    expect(serialized).not.toContain("evidence");
    expect(serialized).not.toContain("telegramChatId");
  });

  it("emits exactly the agreed public field set, so new columns cannot leak in", () => {
    // If this fails, someone added a field to CalendarEvent and to the mapper.
    // Confirm it is genuinely safe to publish before updating this list.
    expect(Object.keys(toPublicPayload(event)).sort()).toEqual(
      [
        "address",
        "allDay",
        "description",
        "endAt",
        "eventDate",
        "id",
        "locationName",
        "rsvpUrl",
        "sourceLabel",
        "startAt",
        "timezone",
        "title",
      ].sort(),
    );
  });
});
