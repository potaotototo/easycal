export type EventStatus = "confirmed" | "unconfirmed" | "dismissed";
export type Confidence = "high" | "medium" | "low";

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
}

/** A copied public representation: no raw message text, Telegram IDs, or source URLs. */
export interface ShareSnapshotEvent extends CalendarEvent {
  sourceLabel: string | null;
}
