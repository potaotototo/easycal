import { randomUUID } from "node:crypto";
import { isEventCategory, type CalendarEvent, type EventCandidate } from "@easycal/contracts/event";
import type { Queryable } from "../types.js";
import { getOrCreatePreferences } from "./preferences.js";

export interface StoredCandidate {
  id: string;
  userId: string;
  candidate: EventCandidate;
}

/**
 * Finds a candidate already built from exactly this set of source messages.
 * Re-syncing the overlap window re-derives the same chains, so identity is the
 * evidence set rather than anything the parser generates.
 */
export async function findCandidateByEvidence(
  db: Queryable,
  userId: string,
  rawMessageIds: string[],
): Promise<{ id: string; status: string } | null> {
  const sorted = [...rawMessageIds].sort();
  const { rows } = await db.query(
    `select ec.id, ec.status
       from event_candidates ec
       join event_evidence ee on ee.event_candidate_id = ec.id
      where ec.user_id = $1
      group by ec.id, ec.status
     having array_agg(ee.raw_message_id::text order by ee.raw_message_id::text) = $2::text[]`,
    [userId, sorted],
  );
  return rows[0] ? { id: rows[0]["id"] as string, status: rows[0]["status"] as string } : null;
}

/**
 * Writes a candidate and its evidence links. A candidate the user already
 * dismissed is left untouched, so dismissal survives every later sync.
 */
export async function saveCandidate(
  db: Queryable,
  userId: string,
  candidate: EventCandidate,
  rawMessageIds: string[],
): Promise<{ id: string; created: boolean; skipped: boolean }> {
  const existing = await findCandidateByEvidence(db, userId, rawMessageIds);

  if (existing?.status === "dismissed") {
    return { id: existing.id, created: false, skipped: true };
  }

  if (existing) {
    await db.query(
      `update event_candidates
          set status = $2, confidence = $3, payload = $4::jsonb,
              review_reasons = $5::jsonb, updated_at = now()
        where id = $1`,
      [
        existing.id,
        candidate.status,
        candidate.confidence,
        JSON.stringify(candidate),
        JSON.stringify(candidate.reviewReasons),
      ],
    );
    return { id: existing.id, created: false, skipped: false };
  }

  const id = randomUUID();
  await db.query(
    `insert into event_candidates
       (id, user_id, status, confidence, payload, review_reasons)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      id,
      userId,
      candidate.status,
      candidate.confidence,
      JSON.stringify(candidate),
      JSON.stringify(candidate.reviewReasons),
    ],
  );
  for (const rawMessageId of rawMessageIds) {
    await db.query(
      `insert into event_evidence (event_candidate_id, raw_message_id)
       values ($1, $2) on conflict do nothing`,
      [id, rawMessageId],
    );
  }
  return { id, created: true, skipped: false };
}

export interface CalendarEventInput {
  title: string;
  description: string | null;
  eventDate: string;
  startAt: string | null;
  endAt: string | null;
  timezone: string | null;
  allDay: boolean;
  locationName: string | null;
  address: string | null;
  rsvpUrl: string | null;
  directionsChannel: string | null;
  sourceLabel: string | null;
  categories: CalendarEvent["categories"];
}

/**
 * Promotes a confirmed candidate to a calendar event. The table's CHECK constraint
 * enforces the all-day rule (a date with no time is an all-day event), so this
 * nulls the timestamps rather than letting a caller violate it.
 */
export async function upsertCalendarEvent(
  db: Queryable,
  candidateId: string,
  userId: string,
  event: CalendarEventInput,
): Promise<string> {
  const startAt = event.allDay ? null : event.startAt;
  const endAt = event.allDay ? null : event.endAt;
  if (!event.allDay && !startAt) {
    throw new Error("A timed event must have startAt");
  }
  if (event.categories.length === 0 || event.categories.some((category) => !isEventCategory(category))) {
    throw new Error("At least one valid event category is required");
  }

  const { rows } = await db.query(
    `insert into calendar_events
       (id, candidate_id, user_id, title, description, event_date, start_at, end_at,
        timezone, all_day, location_name, address, rsvp_url, directions_channel, source_label, categories)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::text[])
     on conflict (candidate_id) do update
       set title = excluded.title, description = excluded.description,
           event_date = excluded.event_date, start_at = excluded.start_at,
           end_at = excluded.end_at, timezone = excluded.timezone,
           all_day = excluded.all_day, location_name = excluded.location_name,
           address = excluded.address, rsvp_url = excluded.rsvp_url,
           directions_channel = excluded.directions_channel,
           source_label = excluded.source_label, categories = excluded.categories
     returning id`,
    [
      randomUUID(), candidateId, userId, event.title, event.description, event.eventDate,
      startAt, endAt, event.timezone, event.allDay, event.locationName, event.address,
      event.rsvpUrl, event.directionsChannel, event.sourceLabel,
      event.categories,
    ],
  );
  return rows[0]!["id"] as string;
}

export interface EventFilters {
  from?: string;
  to?: string;
  sourceChatId?: string;
  query?: string;
  limit?: number;
}

/** Every read is scoped to the user here, not only in the route handler. */
export async function listEvents(
  db: Queryable,
  userId: string,
  filters: EventFilters = {},
): Promise<CalendarEvent[]> {
  await getOrCreatePreferences(db, userId);
  const conditions = ["e.user_id = $1", "c.status <> 'dismissed'"];
  const params: unknown[] = [userId];

  if (filters.from) {
    params.push(filters.from);
    conditions.push(`e.event_date >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`e.event_date <= $${params.length}`);
  }
  if (filters.query) {
    params.push(`%${filters.query}%`);
    conditions.push(
      `(e.title ilike $${params.length} or coalesce(e.description, '') ilike $${params.length})`,
    );
  }
  if (filters.sourceChatId) {
    params.push(filters.sourceChatId);
    conditions.push(
      `exists (select 1 from event_evidence ev
                 join raw_messages rm on rm.id = ev.raw_message_id
                where ev.event_candidate_id = e.candidate_id
                  and rm.source_chat_id = $${params.length})`,
    );
  }
  params.push(filters.limit ?? 200);

  const { rows } = await db.query(
    `select e.id, e.title, e.description, e.event_date, e.start_at, e.end_at,
            e.timezone, e.all_day, e.location_name, e.address, e.rsvp_url, e.source_label,
            e.categories
       from calendar_events e
       join event_candidates c on c.id = e.candidate_id
       join user_preferences p on p.user_id = e.user_id
      where ${conditions.join(" and ")}
        and e.categories && p.interest_categories
        and (
          cardinality(p.location_terms) = 0
          or exists (
            select 1 from unnest(p.location_terms) as preferred_location
             where position(lower(preferred_location) in lower(concat_ws(' ', e.location_name, e.address))) > 0
          )
        )
      order by e.event_date asc, e.start_at asc nulls first
      limit $${params.length}`,
    params,
  );
  return rows.map(mapCalendarEvent);
}

export async function findEventById(
  db: Queryable,
  userId: string,
  eventId: string,
): Promise<CalendarEvent | null> {
  const { rows } = await db.query(
    `select id, title, description, event_date, start_at, end_at, timezone,
            all_day, location_name, address, rsvp_url, source_label, categories
       from calendar_events where id = $1 and user_id = $2`,
    [eventId, userId],
  );
  return rows[0] ? mapCalendarEvent(rows[0]) : null;
}

/** Dismissing hides the event and stops the same evidence producing it again. */
export async function dismissEvent(
  db: Queryable,
  userId: string,
  eventId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update event_candidates set status = 'dismissed', updated_at = now()
      where user_id = $1
        and id = (select candidate_id from calendar_events where id = $2 and user_id = $1)`,
    [userId, eventId],
  );
  return (rowCount ?? 0) > 0;
}

export async function correctEvent(
  db: Queryable,
  userId: string,
  eventId: string,
  patch: Partial<Pick<CalendarEventInput, "title" | "locationName" | "address" | "rsvpUrl">>,
): Promise<CalendarEvent | null> {
  const sets: string[] = [];
  const params: unknown[] = [eventId, userId];
  for (const [column, value] of [
    ["title", patch.title],
    ["location_name", patch.locationName],
    ["address", patch.address],
    ["rsvp_url", patch.rsvpUrl],
  ] as const) {
    if (value !== undefined) {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (sets.length === 0) return findEventById(db, userId, eventId);

  await db.query(
    `update calendar_events set ${sets.join(", ")} where id = $1 and user_id = $2`,
    params,
  );
  return findEventById(db, userId, eventId);
}

function mapCalendarEvent(row: Record<string, unknown>): CalendarEvent {
  // configurePgTypes() keeps `date` columns as 'YYYY-MM-DD' strings; the Date
  // branch only survives for callers using a pool that skipped that setup.
  const eventDate = row["event_date"] as Date | string;
  return {
    id: row["id"] as string,
    title: row["title"] as string,
    description: (row["description"] as string | null) ?? null,
    eventDate:
      eventDate instanceof Date ? eventDate.toISOString().slice(0, 10) : String(eventDate),
    startAt: (row["start_at"] as Date | null)?.toISOString() ?? null,
    endAt: (row["end_at"] as Date | null)?.toISOString() ?? null,
    timezone: (row["timezone"] as string | null) ?? null,
    allDay: row["all_day"] as boolean,
    locationName: (row["location_name"] as string | null) ?? null,
    address: (row["address"] as string | null) ?? null,
    rsvpUrl: (row["rsvp_url"] as string | null) ?? null,
    sourceLabel: (row["source_label"] as string | null) ?? null,
    categories: row["categories"] as CalendarEvent["categories"],
  };
}
