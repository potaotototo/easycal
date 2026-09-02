import type { CalendarEvent, ShareSnapshotEvent } from "@easycal/contracts/event";

/**
 * The ONLY path from private data to a public share snapshot.
 *
 * Deliberately an explicit allowlist rather than a spread: if someone later adds a
 * field to `CalendarEvent` — a source chat id, a raw excerpt — it does not silently
 * become public. Anything new has to be added here on purpose, and the leak tests in
 * publicPayload.test.ts assert that private material never appears in the output.
 */
export function toPublicPayload(event: CalendarEvent): ShareSnapshotEvent {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    startAt: event.startAt,
    endAt: event.endAt,
    eventDate: event.eventDate,
    timezone: event.timezone,
    allDay: event.allDay,
    locationName: event.locationName,
    address: event.address,
    rsvpUrl: event.rsvpUrl,
    sourceLabel: event.sourceLabel,
  };
}
