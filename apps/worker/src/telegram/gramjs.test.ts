import { Api } from "telegram";
import { describe, expect, it } from "vitest";
import { extractLinkEntities } from "./gramjs.js";
import { normalizeText } from "./port.js";

/**
 * `extractLinkEntities` is the one piece of the real GramJS adapter that can be
 * tested offline, and it matters: Telegram delivers link text and link targets
 * separately, so an RSVP button reading "sign up here" carries its URL only in the
 * entity. Losing that loses the RSVP link the product promises.
 */

describe("extractLinkEntities", () => {
  it("recovers the url behind hyperlinked text", () => {
    const text = "NOC sharing\nRSVP here for a seat";
    const entities = [
      new Api.MessageEntityTextUrl({
        offset: text.indexOf("RSVP here"),
        length: "RSVP here".length,
        url: "https://forms.cloud.microsoft/r/0YVwa8YMEy",
      }),
    ];

    expect(extractLinkEntities(text, entities)).toEqual([
      {
        label: "RSVP here",
        url: "https://forms.cloud.microsoft/r/0YVwa8YMEy",
        offset: text.indexOf("RSVP here"),
        length: 9,
      },
    ]);
  });

  it("captures a bare url, where the label is the url itself", () => {
    const text = "Register at https://example.com/signup today";
    const url = "https://example.com/signup";
    const entities = [
      new Api.MessageEntityUrl({ offset: text.indexOf(url), length: url.length }),
    ];

    const [link] = extractLinkEntities(text, entities);
    expect(link).toMatchObject({ label: url, url });
  });

  it("ignores formatting entities that are not links", () => {
    const text = "Bold event title";
    const entities = [
      new Api.MessageEntityBold({ offset: 0, length: 4 }),
      new Api.MessageEntityItalic({ offset: 5, length: 5 }),
    ];
    expect(extractLinkEntities(text, entities)).toEqual([]);
  });

  it("keeps multiple links in order", () => {
    const text = "RSVP here or read more";
    const entities = [
      new Api.MessageEntityTextUrl({ offset: 0, length: 9, url: "https://a.example/rsvp" }),
      new Api.MessageEntityTextUrl({ offset: 13, length: 9, url: "https://b.example/info" }),
    ];
    expect(extractLinkEntities(text, entities).map((l) => l.url)).toEqual([
      "https://a.example/rsvp",
      "https://b.example/info",
    ]);
  });

  it("returns nothing for a message with no entities", () => {
    expect(extractLinkEntities("plain text", [])).toEqual([]);
  });
});

describe("normalizeText", () => {
  it("collapses runs of spaces and trims each line", () => {
    expect(normalizeText("  NOC   sharing  \n   4pm  ")).toBe("NOC sharing\n4pm");
  });

  it("collapses excess blank lines but keeps paragraph breaks", () => {
    expect(normalizeText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("normalises CRLF", () => {
    expect(normalizeText("a\r\nb")).toBe("a\nb");
  });

  it("leaves emoji markers intact, since the parser keys on them", () => {
    expect(normalizeText("📅 2 Sep\n📍 Venue")).toBe("📅 2 Sep\n📍 Venue");
  });
});
