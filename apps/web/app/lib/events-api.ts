import type { EventCategory, UserPreferencesView } from './preferences';
import { clearSessionToken, NotAuthenticatedError, readSessionToken } from './session.ts';

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
  categories: EventCategory[];
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
  events: Omit<CalendarEventView, 'status' | 'categories'>[];
}

export function normalizePublicSnapshot(payload: unknown): PublicSnapshot {
  if (!payload || typeof payload !== 'object') {
    throw new Error('The snapshot response was not recognized.');
  }
  const candidate = payload as { title?: unknown; events?: unknown };
  if (typeof candidate.title !== 'string' || !Array.isArray(candidate.events)) {
    throw new Error('The snapshot response was not recognized.');
  }

  const events = candidate.events.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const event = value as Partial<CalendarEventView>;
    if (typeof event.id !== 'string' || typeof event.title !== 'string' || typeof event.eventDate !== 'string') {
      return [];
    }
    return [{
      id: event.id,
      title: event.title,
      description: null,
      startAt: typeof event.startAt === 'string' ? event.startAt : null,
      endAt: typeof event.endAt === 'string' ? event.endAt : null,
      eventDate: event.eventDate,
      timezone: typeof event.timezone === 'string' ? event.timezone : null,
      allDay: event.allDay === true,
      locationName: typeof event.locationName === 'string' ? event.locationName : null,
      address: typeof event.address === 'string' ? event.address : null,
      rsvpUrl: typeof event.rsvpUrl === 'string' ? event.rsvpUrl : null,
      sourceLabel: typeof event.sourceLabel === 'string' ? event.sourceLabel : null,
    }];
  });

  return { title: candidate.title, events };
}

export const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');

export const isDemoMode = !apiBaseUrl;

function apiUrl(path: string) {
  return `${apiBaseUrl ?? ''}${path}`;
}

/**
 * The API is on a different origin, so a session cookie would be a third-party
 * cookie. We send the bearer token the login flow stored instead.
 */
function authHeaders(): Record<string, string> {
  const token = readSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Turns an expired or missing session into a typed error the UI can act on. */
function assertAuthenticated(response: Response) {
  if (response.status === 401) {
    clearSessionToken();
    throw new NotAuthenticatedError();
  }
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
    categories: event.categories ?? ['other'],
  } satisfies CalendarEventView;
}

export async function fetchEvents(from: string, to: string) {
  const query = new URLSearchParams({ from, to });
  const response = await fetch(apiUrl(`/v1/events?${query}`), {
    credentials: 'include',
    headers: { Accept: 'application/json', ...authHeaders() },
  });

  assertAuthenticated(response);

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

/**
 * The API returns the updated event directly. Older builds wrapped it in
 * `{ event }`, so both are unwrapped here — with a real type guard, because
 * `'event' in payload` does not narrow an optional property.
 */
function unwrapEvent(
  payload: CalendarEventView | { event?: CalendarEventView },
): CalendarEventView | null {
  if (payload && typeof payload === 'object' && 'id' in payload) {
    return payload as CalendarEventView;
  }
  return (payload as { event?: CalendarEventView }).event ?? null;
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
      ...authHeaders(),
    },
    body: JSON.stringify({ action: status === 'dismissed' ? 'dismiss' : 'confirm' }),
  });

  assertAuthenticated(response);

  if (!response.ok) {
    throw new Error(`Could not update event (${response.status})`);
  }

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json() as CalendarEventView | { event?: CalendarEventView };
  const event = unwrapEvent(payload);
  return event ? normalizeEvent(event) : null;
}

export async function correctEvent(id: string, correction: EventCorrection) {
  const response = await fetch(apiUrl(`/v1/events/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      action: 'correct',
      title: correction.title,
      eventDate: correction.eventDate,
      startAt: correction.startAt,
      endAt: correction.endAt,
      allDay: correction.allDay,
      locationName: correction.locationName,
      address: correction.address,
      rsvpUrl: correction.rsvpUrl,
    }),
  });

  assertAuthenticated(response);

  if (!response.ok) {
    throw new Error(`Could not save correction (${response.status})`);
  }

  const payload = await response.json() as CalendarEventView | { event?: CalendarEventView };
  const event = unwrapEvent(payload);
  const normalized = event ? normalizeEvent(event) : null;
  if (!normalized) throw new Error('The updated event response was not recognized.');
  return normalized;
}

export async function fetchPreferences(): Promise<UserPreferencesView> {
  const response = await fetch(apiUrl('/v1/preferences'), {
    credentials: 'include',
    headers: { Accept: 'application/json', ...authHeaders() },
  });
  assertAuthenticated(response);
  if (!response.ok) throw new Error(`Could not load preferences (${response.status})`);
  return response.json() as Promise<UserPreferencesView>;
}

export async function savePreferences(
  preferences: UserPreferencesView,
): Promise<UserPreferencesView> {
  const response = await fetch(apiUrl('/v1/preferences'), {
    method: 'PUT',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(preferences),
  });
  assertAuthenticated(response);
  if (!response.ok) throw new Error(`Could not save preferences (${response.status})`);
  return response.json() as Promise<UserPreferencesView>;
}

export async function fetchPublicSnapshot(token: string): Promise<PublicSnapshot> {
  const response = await fetch(apiUrl(`/s/${encodeURIComponent(token)}`), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(response.status === 404 ? 'Snapshot not found' : 'Could not load snapshot');
  }

  return normalizePublicSnapshot(await response.json());
}

export function icsDownloadUrl(from: string, to: string) {
  const query = new URLSearchParams({ from, to });
  return apiUrl(`/v1/events.ics?${query}`);
}

/**
 * A plain link cannot carry an Authorization header, and putting the session token
 * in the URL would leak it into history and server logs. So fetch the calendar
 * authenticated and hand the browser a blob instead.
 */
export async function downloadIcs(from: string, to: string) {
  const response = await fetch(icsDownloadUrl(from, to), {
    credentials: 'include',
    headers: { Accept: 'text/calendar', ...authHeaders() },
  });

  assertAuthenticated(response);

  if (!response.ok) {
    throw new Error(`Could not export the calendar (${response.status})`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'easycal.ics';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
