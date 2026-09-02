import {
  isEventCategory,
  type CalendarEvent,
  type EventCategory,
  type EventCandidate,
} from "@easycal/contracts/event";
import type { Queryable } from "../types.js";
import { upsertCalendarEvent, type CalendarEventInput, type EventFilters } from "./events.js";
import { getOrCreatePreferences } from "./preferences.js";

/**
 * What apps/web renders. `CalendarEvent` in the contract describes a *promoted*
 * event, but the review UI also needs candidates that are not confirmed yet, so the
 * view adds the status the frontend keys its buckets off.
 *
 * Ids are stable per row: a promoted event uses its calendar_events id, an
 * unconfirmed candidate uses its event_candidates id. Every mutation below accepts
 * either, so the frontend never has to know which it is holding.
 */
export interface CalendarEventView extends CalendarEvent {
  status: "confirmed" | "unconfirmed";
}

/** Promoted events plus still-unconfirmed candidates, in one date-ordered list. */
export async function listEventViews(
  db: Queryable,
  userId: string,
  filters: EventFilters = {},
): Promise<CalendarEventView[]> {
  const confirmed = await listConfirmed(db, userId, filters);
  const unconfirmed = await listUnconfirmed(db, userId, filters);

  return [...confirmed, ...unconfirmed].sort((a, b) => {
    if (a.eventDate !== b.eventDate) return a.eventDate < b.eventDate ? -1 : 1;
    return (a.startAt ?? "") < (b.startAt ?? "") ? -1 : 1;
  });
}

async function listConfirmed(
  db: Queryable,
  userId: string,
  filters: EventFilters,
): Promise<CalendarEventView[]> {
  await getOrCreatePreferences(db, userId);
  const conditions = ["e.user_id = $1", "c.status = 'confirmed'"];
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

  return rows.map((row) => ({
    id: row["id"] as string,
    title: row["title"] as string,
    description: (row["description"] as string | null) ?? null,
    eventDate: String(row["event_date"]),
    startAt: (row["start_at"] as Date | null)?.toISOString() ?? null,
    endAt: (row["end_at"] as Date | null)?.toISOString() ?? null,
    timezone: (row["timezone"] as string | null) ?? null,
    allDay: row["all_day"] as boolean,
    locationName: (row["location_name"] as string | null) ?? null,
    address: (row["address"] as string | null) ?? null,
    rsvpUrl: (row["rsvp_url"] as string | null) ?? null,
    sourceLabel: (row["source_label"] as string | null) ?? null,
    categories: (row["categories"] as CalendarEvent["categories"] | null) ?? ["other"],
    status: "confirmed",
  }));
}

/**
 * Candidates the parser could not confirm. Their shape lives in the stored payload,
 * and the filters are applied in JS because the payload is jsonb rather than columns.
 */
async function listUnconfirmed(
  db: Queryable,
  userId: string,
  filters: EventFilters,
): Promise<CalendarEventView[]> {
  const preferences = await getOrCreatePreferences(db, userId);
  const { rows } = await db.query(
    `select id, payload from event_candidates
      where user_id = $1 and status = 'unconfirmed'
      order by created_at desc
      limit $2`,
    [userId, filters.limit ?? 200],
  );

  const views: CalendarEventView[] = [];
  for (const row of rows) {
    const payload = row["payload"] as Partial<EventCandidate>;
    // The frontend cannot render an event with no date or title, and neither can a
    // calendar — those candidates stay invisible until corrected.
    if (!payload.eventDate || !payload.title) continue;
    if (filters.from && payload.eventDate < filters.from) continue;
    if (filters.to && payload.eventDate > filters.to) continue;
    if (filters.query && !payload.title.toLowerCase().includes(filters.query.toLowerCase())) {
      continue;
    }
    const categories = (payload.categories ?? []).filter(isEventCategory);
    const normalizedCategories: EventCategory[] = categories.length > 0 ? categories : ["other"];
    if (!normalizedCategories.some((category) => preferences.interestCategories.includes(category))) {
      continue;
    }
    if (preferences.locationTerms.length > 0) {
      const location = `${payload.locationName ?? ""} ${payload.address ?? ""}`.toLocaleLowerCase();
      if (!preferences.locationTerms.some((term) => location.includes(term.toLocaleLowerCase()))) {
        continue;
      }
    }

    views.push({
      id: row["id"] as string,
      title: payload.title,
      description: payload.description ?? null,
      eventDate: payload.eventDate,
      startAt: payload.startAt ?? null,
      endAt: payload.endAt ?? null,
      timezone: payload.timezone ?? null,
      allDay: payload.allDay ?? true,
      locationName: payload.locationName ?? null,
      address: payload.address ?? null,
      rsvpUrl: payload.rsvpUrl ?? null,
      sourceLabel: null,
      categories: normalizedCategories,
      status: "unconfirmed",
    });
  }
  return views;
}

/** Resolves an id that may be either a calendar event or a bare candidate. */
async function resolveCandidateId(
  db: Queryable,
  userId: string,
  id: string,
): Promise<{ candidateId: string; eventId: string | null } | null> {
  const { rows } = await db.query(
    `select c.id as candidate_id, e.id as event_id
       from event_candidates c
       left join calendar_events e on e.candidate_id = c.id
      where c.user_id = $1 and (c.id = $2 or e.id = $2)
      limit 1`,
    [userId, id],
  );
  return rows[0]
    ? {
        candidateId: rows[0]["candidate_id"] as string,
        eventId: (rows[0]["event_id"] as string | null) ?? null,
      }
    : null;
}

export async function dismissById(db: Queryable, userId: string, id: string): Promise<boolean> {
  const resolved = await resolveCandidateId(db, userId, id);
  if (!resolved) return false;
  await db.query(
    `update event_candidates set status = 'dismissed', updated_at = now() where id = $1`,
    [resolved.candidateId],
  );
  return true;
}

/**
 * Confirming an unconfirmed candidate promotes it into the calendar. This is the
 * review flow: the parser was unsure, the user says it is real.
 */
export async function confirmById(
  db: Queryable,
  userId: string,
  id: string,
): Promise<CalendarEventView | null> {
  const resolved = await resolveCandidateId(db, userId, id);
  if (!resolved) return null;

  const { rows } = await db.query(`select payload from event_candidates where id = $1`, [
    resolved.candidateId,
  ]);
  const payload = rows[0]?.["payload"] as Partial<EventCandidate> | undefined;
  if (!payload?.eventDate || !payload.title) return null;

  await db.query(
    `update event_candidates set status = 'confirmed', updated_at = now() where id = $1`,
    [resolved.candidateId],
  );

  const eventId = await upsertCalendarEvent(db, resolved.candidateId, userId, {
    title: payload.title,
    description: payload.description ?? null,
    eventDate: payload.eventDate,
    startAt: payload.startAt ?? null,
    endAt: payload.endAt ?? null,
    timezone: payload.timezone ?? null,
    allDay: payload.allDay ?? !payload.startAt,
    locationName: payload.locationName ?? null,
    address: payload.address ?? null,
    rsvpUrl: payload.rsvpUrl ?? null,
    directionsChannel: payload.directionsChannel ?? null,
    sourceLabel: null,
    categories: (payload.categories ?? []).filter(isEventCategory).length > 0
      ? (payload.categories ?? []).filter(isEventCategory)
      : ["other"],
  });

  return findViewById(db, userId, eventId);
}

export type EventCorrection = Partial<
  Pick<
    CalendarEventInput,
    "title" | "eventDate" | "startAt" | "endAt" | "allDay" | "locationName" | "address" | "rsvpUrl"
  >
>;

/**
 * Applies a user correction. A correction is also an implicit confirmation: the user
 * has looked at it and told us what it really says, so an unconfirmed candidate is
 * promoted rather than left in review limbo.
 */
export async function correctById(
  db: Queryable,
  userId: string,
  id: string,
  correction: EventCorrection,
): Promise<CalendarEventView | null> {
  const resolved = await resolveCandidateId(db, userId, id);
  if (!resolved) return null;

  const { rows } = await db.query(`select payload from event_candidates where id = $1`, [
    resolved.candidateId,
  ]);
  const payload = (rows[0]?.["payload"] ?? {}) as Partial<EventCandidate>;

  // Once promoted, the calendar_events row is the live truth — the stored candidate
  // payload can be sparser (an older parser, or a candidate created without one).
  // Layer it over the payload so a correction never loses existing fields.
  const current = resolved.eventId ? await findViewById(db, userId, resolved.eventId) : null;
  const base: Partial<EventCandidate> = current
    ? {
        ...payload,
        title: current.title,
        description: current.description,
        eventDate: current.eventDate,
        startAt: current.startAt,
        endAt: current.endAt,
        timezone: current.timezone,
        allDay: current.allDay,
        locationName: current.locationName,
        address: current.address,
        rsvpUrl: current.rsvpUrl,
        categories: current.categories,
      }
    : payload;

  const merged = { ...base, ...correction };
  const allDay = correction.allDay ?? base.allDay ?? !merged.startAt;
  // The calendar_events CHECK constraint forbids times on an all-day event.
  const startAt = allDay ? null : (merged.startAt ?? null);
  const endAt = allDay ? null : (merged.endAt ?? null);

  if (!merged.eventDate || !merged.title) return null;
  if (!allDay && !startAt) return null;

  await db.query(
    `update event_candidates
        set payload = $2::jsonb, status = 'confirmed', updated_at = now()
      where id = $1`,
    [resolved.candidateId, JSON.stringify({ ...merged, allDay, startAt, endAt })],
  );

  const { rows: labelRows } = await db.query(
    `select source_label from calendar_events where candidate_id = $1`,
    [resolved.candidateId],
  );

  const eventId = await upsertCalendarEvent(db, resolved.candidateId, userId, {
    title: merged.title,
    description: merged.description ?? null,
    eventDate: merged.eventDate,
    startAt,
    endAt,
    timezone: merged.timezone ?? null,
    allDay,
    locationName: merged.locationName ?? null,
    address: merged.address ?? null,
    rsvpUrl: merged.rsvpUrl ?? null,
    directionsChannel: merged.directionsChannel ?? null,
    sourceLabel: (labelRows[0]?.["source_label"] as string | null) ?? null,
    categories: (merged.categories ?? []).filter(isEventCategory).length > 0
      ? (merged.categories ?? []).filter(isEventCategory)
      : ["other"],
  });

  return findViewById(db, userId, eventId);
}

export async function findViewById(
  db: Queryable,
  userId: string,
  id: string,
): Promise<CalendarEventView | null> {
  const resolved = await resolveCandidateId(db, userId, id);
  if (!resolved) return null;

  const views = resolved.eventId
    ? await listConfirmed(db, userId, { limit: 1000 })
    : await listUnconfirmed(db, userId, { limit: 1000 });

  const wanted = resolved.eventId ?? resolved.candidateId;
  return views.find((view) => view.id === wanted) ?? null;
}
