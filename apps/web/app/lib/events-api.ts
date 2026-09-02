export type EventReviewStatus = 'confirmed' | 'unconfirmed' | 'dismissed';

export interface CalendarEventView {
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
  status: EventReviewStatus;
}

export type EventCorrection = Pick<
  CalendarEventView,
  | 'title'
  | 'eventDate'
  | 'startAt'
  | 'endAt'
  | 'allDay'
  | 'locationName'
  | 'address'
  | 'rsvpUrl'
>;

export interface PublicSnapshot {
  title: string;
  events: Omit<CalendarEventView, 'status'>[];
}

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');

export const isDemoMode = !apiBaseUrl;

function apiUrl(path: string) {
  return `${apiBaseUrl ?? ''}${path}`;
}

function normalizeEvent(event: Partial<CalendarEventView> & { id: string }) {
  const eventDate = event.eventDate ?? event.startAt?.slice(0, 10);

  if (!event.title || !eventDate) {
    return null;
  }

  return {
    id: event.id,
    title: event.title,
    description: event.description ?? null,
    startAt: event.startAt ?? null,
    endAt: event.endAt ?? null,
    eventDate,
    timezone: event.timezone ?? null,
    allDay: event.allDay ?? !event.startAt,
    locationName: event.locationName ?? null,
    address: event.address ?? null,
    rsvpUrl: event.rsvpUrl ?? null,
    sourceLabel: event.sourceLabel ?? null,
    status: event.status ?? 'confirmed',
  } satisfies CalendarEventView;
}

export async function fetchEvents(from: string, to: string) {
  const query = new URLSearchParams({ from, to });
  const response = await fetch(apiUrl(`/v1/events?${query}`), {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Could not load events (${response.status})`);
  }

  const payload = (await response.json()) as
    | CalendarEventView[]
    | { events?: CalendarEventView[] };
  const events = Array.isArray(payload) ? payload : payload.events;

  if (!events) {
    throw new Error('The events response was not recognized.');
  }

  return events.flatMap((event) => {
    const normalized = normalizeEvent(event);
    return normalized ? [normalized] : [];
  });
}

export async function updateEventStatus(
  id: string,
  status: Extract<EventReviewStatus, 'confirmed' | 'dismissed'>,
) {
  const response = await fetch(apiUrl(`/v1/events/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    throw new Error(`Could not update event (${response.status})`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json() as Promise<CalendarEventView>;
}

export async function correctEvent(id: string, correction: EventCorrection) {
  const response = await fetch(apiUrl(`/v1/events/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ correction }),
  });

  if (!response.ok) {
    throw new Error(`Could not save correction (${response.status})`);
  }

  return response.json() as Promise<CalendarEventView>;
}

export async function fetchPublicSnapshot(token: string): Promise<PublicSnapshot> {
  const response = await fetch(apiUrl(`/s/${encodeURIComponent(token)}`), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(response.status === 404 ? 'Snapshot not found' : 'Could not load snapshot');
  }

  const payload = (await response.json()) as Partial<PublicSnapshot>;
  if (!payload.title || !Array.isArray(payload.events)) {
    throw new Error('The snapshot response was not recognized.');
  }

  return { title: payload.title, events: payload.events };
}

export function icsDownloadUrl(from: string, to: string) {
  const query = new URLSearchParams({ from, to });
  return apiUrl(`/v1/events.ics?${query}`);
}
