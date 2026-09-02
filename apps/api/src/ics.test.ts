import type { CalendarEvent } from "@easycal/contracts/event";
import { describe, expect, it } from "vitest";
import { buildIcs, escapeText, foldLine } from "./ics.js";

const DTSTAMP = new Date("2026-01-01T00:00:00Z");

const timed: CalendarEvent = {
  id: "evt-1",
  title: "NOC sharing",
  description: null,
  eventDate: "2025-09-02",
  startAt: "2025-09-02T08:00:00.000Z", // 16:00 Asia/Singapore
  endAt: "2025-09-02T10:00:00.000Z",
  timezone: "Asia/Singapore",
  allDay: false,
  locationName: "NUS Enterprise I3 MPH, Level 2",
  address: "21 Heng Mui Keng Terrace, Singapore 119613",
  rsvpUrl: "https://forms.cloud.microsoft/r/0YVwa8YMEy",
  sourceLabel: "NUS Start IT",
  categories: ["entrepreneurship"],
};

const allDay: CalendarEvent = {
  ...timed,
  id: "evt-2",
  title: "Career fair",
  startAt: null,
  endAt: null,
  allDay: true,
};

describe("buildIcs", () => {
  it("emits a timed event in UTC with an exclusive end", () => {
    const ics = buildIcs([timed], { dtstamp: DTSTAMP });
    expect(ics).toContain("DTSTART:20250902T080000Z");
    expect(ics).toContain("DTEND:20250902T100000Z");
    expect(ics).toContain("UID:evt-1@easycal");
  });

  it("emits an all-day event as a DATE with the following day as DTEND", () => {
    const ics = buildIcs([allDay], { dtstamp: DTSTAMP });
    expect(ics).toContain("DTSTART;VALUE=DATE:20250902");
    expect(ics).toContain("DTEND;VALUE=DATE:20250903");
    expect(ics).not.toContain("DTSTART:2025");
  });

  it("uses CRLF line endings and closes the calendar", () => {
    const ics = buildIcs([timed], { dtstamp: DTSTAMP });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.split("\r\n").filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
  });

  it("escapes commas in the location so the field is not split", () => {
    const ics = buildIcs([timed], { dtstamp: DTSTAMP });
    expect(ics).toContain("NUS Enterprise I3 MPH\\, Level 2");
  });

  it("keeps the RSVP url intact", () => {
    expect(buildIcs([timed], { dtstamp: DTSTAMP })).toContain(
      "URL:https://forms.cloud.microsoft/r/0YVwa8YMEy",
    );
  });
});

describe("escapeText", () => {
  it("escapes backslash, semicolon, comma and newline", () => {
    expect(escapeText("a\\b;c,d\ne")).toBe("a\\\\b\;c\\,d\\ne");
  });
});

describe("foldLine", () => {
  it("leaves short lines alone", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds long lines with a leading space on continuations", () => {
    const folded = foldLine(`SUMMARY:${"x".repeat(200)}`);
    const [first, ...rest] = folded.split("\r\n");
    expect(Buffer.from(first!, "utf8").length).toBeLessThanOrEqual(75);
    expect(rest.every((line) => line.startsWith(" "))).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"x".repeat(200)}`);
  });

  it("never splits a multi-byte character", () => {
    const folded = foldLine(`SUMMARY:${"日".repeat(60)}`);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"日".repeat(60)}`);
    expect(folded).not.toContain("�");
  });
});
