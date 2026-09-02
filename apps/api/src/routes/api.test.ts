import {
  EnvKeyProvider,
  encryptOnly,
  issueSession,
  saveConnection,
  saveFolderCache,
  saveFolderSelection,
  startTestDatabase,
  upsertCalendarEvent,
  upsertUserByTelegramId,
  type TestDatabase,
} from "@easycal/db";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { buildServer } from "../server.js";

/**
 * Exercises the HTTP surface end to end with `app.inject`, against a real
 * throwaway Postgres. No network and no Telegram involved.
 */

const KEY = Buffer.alloc(32, 5).toString("base64");

let database: TestDatabase;
let app: FastifyInstance;
let sessionToken: string;
let otherToken: string;
let eventId: string;

beforeAll(async () => {
  database = await startTestDatabase();

  const user = await upsertUserByTelegramId(database.pool, "700100200", "Asia/Singapore");
  const other = await upsertUserByTelegramId(database.pool, "700100201", "UTC");

  const connection = await saveConnection(
    database.pool,
    new EnvKeyProvider(KEY),
    user.id,
    "session",
  );
  await saveFolderSelection(database.pool, {
    connectionId: connection.id,
    telegramFolderId: 2,
    folderTitle: "Opportunities",
    lookbackDays: 7,
  });

  // A confirmed candidate promoted to a calendar event.
  const candidateId = randomUUID();
  await database.pool.query(
    `insert into event_candidates (id, user_id, status, confidence, payload)
     values ($1, $2, 'confirmed', 'high', '{}'::jsonb)`,
    [candidateId, user.id],
  );
  eventId = await upsertCalendarEvent(database.pool, candidateId, user.id, {
    title: "NOC sharing",
    description: null,
    eventDate: "2025-09-02",
    startAt: "2025-09-02T16:00:00+08:00",
    endAt: "2025-09-02T18:00:00+08:00",
    timezone: "Asia/Singapore",
    allDay: false,
    locationName: "NUS Enterprise I3 MPH, Level 2",
    address: "21 Heng Mui Keng Terrace, Singapore 119613",
    rsvpUrl: "https://forms.cloud.microsoft/r/0YVwa8YMEy",
    directionsChannel: "@nusstartit",
    sourceLabel: "NUS Start IT",
  });

  // The API cannot decrypt a session to ask Telegram, so folders come from cache.
  await saveFolderCache(database.pool, connection.id, [
    { telegramFolderId: 2, title: "Opportunities" },
    { telegramFolderId: 3, title: "Personal" },
  ]);

  sessionToken = (await issueSession(database.pool, user.id)).token;
  otherToken = (await issueSession(database.pool, other.id)).token;

  const context: AppContext = {
    db: database.pool,
    keys: encryptOnly(new EnvKeyProvider(KEY)),
    telegram: null,
    loginAttempts: { add() {}, get: () => undefined, remove() {}, sweep() {}, size: 0 } as never,
  };

  app = await buildServer(
    loadEnv({ DATABASE_URL: database.connectionString, LOG_LEVEL: "fatal" }),
    context,
  );
}, 120_000);

afterAll(async () => {
  await app?.close();
  await database?.stop();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("authentication", () => {
  it("rejects private routes without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/events" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "not_authenticated" });
  });

  it("rejects a made-up token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: auth("not-a-real-token"),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /v1/folders", () => {
  it("returns the cached folders and the current selection", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/folders",
      headers: auth(sessionToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.folders.map((f: { title: string }) => f.title)).toEqual([
      "Opportunities",
      "Personal",
    ]);
    expect(body.selected).toMatchObject({
      telegramFolderId: 2,
      folderTitle: "Opportunities",
      lookbackDays: 7,
    });
  });

  it("requires a session", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/folders" });
    expect(response.statusCode).toBe(401);
  });

  it("tells a user with no Telegram connection to connect first", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/folders",
      headers: auth(otherToken),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "no_telegram_connection" });
  });
});

describe("PUT /v1/folder-selection", () => {
  it("changes the selected folder and lookback window", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/folder-selection",
      headers: auth(sessionToken),
      payload: { telegramFolderId: 3, folderTitle: "Personal", lookbackDays: 14 },
    });
    expect(response.statusCode).toBe(200);

    const folders = await app.inject({
      method: "GET",
      url: "/v1/folders",
      headers: auth(sessionToken),
    });
    expect(folders.json().selected).toMatchObject({
      telegramFolderId: 3,
      lookbackDays: 14,
    });

    // Put it back for the tests that follow.
    await app.inject({
      method: "PUT",
      url: "/v1/folder-selection",
      headers: auth(sessionToken),
      payload: { telegramFolderId: 2, folderTitle: "Opportunities", lookbackDays: 7 },
    });
  });

  it("defaults the lookback window to 7 days", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/folder-selection",
      headers: auth(sessionToken),
      payload: { telegramFolderId: 2, folderTitle: "Opportunities" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().selection.lookbackDays).toBe(7);
  });

  it("rejects a lookback window outside the schema's 1..90 range", async () => {
    for (const lookbackDays of [0, 91]) {
      const response = await app.inject({
        method: "PUT",
        url: "/v1/folder-selection",
        headers: auth(sessionToken),
        payload: { telegramFolderId: 2, folderTitle: "Opportunities", lookbackDays },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe("GET /v1/events", () => {
  it("returns the caller's events", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: auth(sessionToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().events).toHaveLength(1);
    expect(response.json().events[0].title).toBe("NOC sharing");
  });

  it("never returns another user's events", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: auth(otherToken),
    });
    expect(response.json().events).toEqual([]);
  });

  it("filters by date range", async () => {
    const outside = await app.inject({
      method: "GET",
      url: "/v1/events?from=2025-10-01&to=2025-10-31",
      headers: auth(sessionToken),
    });
    expect(outside.json().events).toEqual([]);

    const inside = await app.inject({
      method: "GET",
      url: "/v1/events?from=2025-09-01&to=2025-09-30",
      headers: auth(sessionToken),
    });
    expect(inside.json().events).toHaveLength(1);
  });

  it("rejects a malformed date filter", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/events?from=not-a-date",
      headers: auth(sessionToken),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /v1/events.ics", () => {
  it("serves a downloadable calendar containing the event", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/events.ics",
      headers: auth(sessionToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/calendar");
    expect(response.headers["content-disposition"]).toContain("easycal.ics");
    expect(response.body).toContain("BEGIN:VEVENT");
    expect(response.body).toContain("SUMMARY:NOC sharing");
    expect(response.body).toContain("DTSTART:20250902T080000Z");
  });
});

describe("POST /v1/sync-runs", () => {
  it("queues a run, then rate limits the next one", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/sync-runs",
      headers: auth(sessionToken),
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().status).toBe("queued");

    const second = await app.inject({
      method: "POST",
      url: "/v1/sync-runs",
      headers: auth(sessionToken),
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("60");
  });
});

describe("sharing", () => {
  it("publishes a snapshot with no raw message content, then revokes it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/share-snapshots",
      headers: auth(sessionToken),
      payload: { title: "September", eventIds: [eventId] },
    });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json();

    const published = await app.inject({ method: "GET", url: `/s/${token}` });
    expect(published.statusCode).toBe(200);
    expect(published.headers["x-robots-tag"]).toContain("noindex");

    const body = published.body;
    expect(body).toContain("NOC sharing");
    expect(body).not.toContain("telegramChatId");
    expect(body).not.toContain("normalizedText");
    expect(body).not.toContain("@nusstartit"); // directionsChannel stays private

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/share-snapshots/${id}`,
      headers: auth(sessionToken),
    });
    expect(revoked.statusCode).toBe(200);

    const afterRevoke = await app.inject({ method: "GET", url: `/s/${token}` });
    expect(afterRevoke.statusCode).toBe(404);
  });

  it("does not let another user revoke a snapshot", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/share-snapshots",
      headers: auth(sessionToken),
      payload: { title: "Mine", eventIds: [eventId] },
    });
    const { id } = created.json();

    const attempt = await app.inject({
      method: "DELETE",
      url: `/v1/share-snapshots/${id}`,
      headers: auth(otherToken),
    });
    expect(attempt.statusCode).toBe(404);
  });

  it("404s an unknown share token", async () => {
    const response = await app.inject({ method: "GET", url: "/s/definitely-not-a-token" });
    expect(response.statusCode).toBe(404);
  });
});

describe("PATCH /v1/events/:id", () => {
  it("corrects a field", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      headers: auth(sessionToken),
      payload: { action: "correct", title: "NOC sharing (rescheduled)" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().event.title).toBe("NOC sharing (rescheduled)");
  });

  it("dismisses an event so it leaves the calendar", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      headers: auth(sessionToken),
      payload: { action: "dismiss" },
    });
    expect(response.statusCode).toBe(200);

    const events = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: auth(sessionToken),
    });
    expect(events.json().events).toEqual([]);
  });
});
