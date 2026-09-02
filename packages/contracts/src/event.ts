export type EventStatus = "confirmed" | "unconfirmed" | "dismissed";
export type Confidence = "high" | "medium" | "low";

export const EVENT_CATEGORIES = [
  "career",
  "internships",
  "technology",
  "entrepreneurship",
  "education",
  "networking",
  "community",
  "volunteering",
  "sports_wellness",
  "arts_culture",
  "social",
  "other",
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export function isEventCategory(value: unknown): value is EventCategory {
  return typeof value === "string" && (EVENT_CATEGORIES as readonly string[]).includes(value);
}

export interface LinkEntity {
  label: string;
  url: string;
  offset: number;
  length: number;
}

export interface MessageEvidence {
  telegramChatId: string;
  telegramMessageId: string;
  sentAt: string;
  normalizedText: string;
  links: LinkEntity[];
}

export interface EventCandidate {
  id: string;
  status: EventStatus;
  confidence: Confidence;
  title: string | null;
  description: string | null;
  startAt: string | null;
  endAt: string | null;
  eventDate: string | null;
  timezone: string | null;
  allDay: boolean;
  locationName: string | null;
  address: string | null;
  rsvpUrl: string | null;
  directionsChannel: string | null;
  categories: EventCategory[];
  evidence: MessageEvidence[];
  reviewReasons: string[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  startAt: string | null;
  endAt: string | null;
  eventDate: string;
  timezone: string | null;
  allDay: boolean;
  locationName: string | null;
  address: string | null;
  rsvpUrl: string | null;
  sourceLabel: string | null;
  categories: EventCategory[];
}

/** A copied public representation: no raw message text, Telegram IDs, or source URLs. */
export type ShareSnapshotEvent = Omit<CalendarEvent, "categories">;
