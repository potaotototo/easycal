import type { CalendarEvent, EventCandidate, MessageEvidence } from "../../contracts/src/event.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeUrl(value: unknown): string | null {
  const candidate = nullableString(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function validInstant(value: string | null): boolean {
  return value === null || !Number.isNaN(Date.parse(value));
}

export function validateStructuredCandidate(
  value: unknown,
  evidence: MessageEvidence[],
): EventCandidate | null {
  if (!isRecord(value)) return null;
  const eventDate = nullableString(value.eventDate);
  const title = nullableString(value.title);
  const allDay = value.allDay === true;
  const startAt = nullableString(value.startAt);
  const endAt = nullableString(value.endAt);
  const allowedEvidence = new Set(evidence.map((item) => `${item.telegramChatId}:${item.telegramMessageId}`));
  const requestedEvidence = Array.isArray(value.evidence)
    ? value.evidence.filter(isRecord).map((item) => `${String(item.telegramChatId)}:${String(item.telegramMessageId)}`)
    : [];
  const referencesAreValid = requestedEvidence.length > 0 && requestedEvidence.every((id) => allowedEvidence.has(id));

  if (!eventDate || !DATE_ONLY.test(eventDate) || !title || !referencesAreValid) return null;
  if (!validInstant(startAt) || !validInstant(endAt)) return null;
  if (allDay && (startAt || endAt)) return null;
  if (!allDay && !startAt) return null;

  const rsvpUrl = safeUrl(value.rsvpUrl);
  if (value.rsvpUrl && !rsvpUrl) return null;

  return {
    id: nullableString(value.id) ?? `model:${evidence[0]?.telegramMessageId ?? "candidate"}`,
    status: "confirmed",
    confidence: value.confidence === "high" ? "high" : "medium",
    title,
    description: nullableString(value.description),
    startAt,
    endAt,
    eventDate,
    timezone: nullableString(value.timezone),
    allDay,
    locationName: nullableString(value.locationName),
    address: nullableString(value.address),
    rsvpUrl,
    directionsChannel: nullableString(value.directionsChannel),
    evidence,
    reviewReasons: Array.isArray(value.reviewReasons)
      ? value.reviewReasons.filter((item): item is string => typeof item === "string")
      : ["Extracted by the structured-model fallback"],
  };
}

export function candidateToCalendarEvent(candidate: EventCandidate): CalendarEvent {
  if (candidate.status !== "confirmed" || !candidate.title || !candidate.eventDate) {
    throw new Error("Only confirmed candidates with a title and exact date can become calendar events");
  }
  if (!DATE_ONLY.test(candidate.eventDate)) throw new Error("Calendar event date must be YYYY-MM-DD");
  if (candidate.allDay && (candidate.startAt || candidate.endAt)) {
    throw new Error("All-day events cannot contain timed instants");
  }
  if (!candidate.allDay && (!candidate.startAt || !validInstant(candidate.startAt))) {
    throw new Error("Timed events require a valid start instant");
  }
  if (candidate.rsvpUrl && !safeUrl(candidate.rsvpUrl)) throw new Error("RSVP URL must use HTTP or HTTPS");

  return {
    id: candidate.id,
    title: candidate.title,
    description: candidate.description,
    startAt: candidate.startAt,
    endAt: candidate.endAt,
    eventDate: candidate.eventDate,
    timezone: candidate.timezone,
    allDay: candidate.allDay,
    locationName: candidate.locationName,
    address: candidate.address,
    rsvpUrl: candidate.rsvpUrl,
    sourceLabel: null,
  };
}
