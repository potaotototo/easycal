'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { demoEvents } from './lib/demo-events';
import {
  correctEvent,
  downloadIcs,
  fetchEvents,
  fetchPreferences,
  icsDownloadUrl,
  isDemoMode,
  savePreferences,
  updateEventStatus,
  type CalendarEventView,
  type EventCorrection,
  type EventReviewStatus,
} from './lib/events-api';
import {
  CATEGORY_LABELS,
  DEFAULT_PREFERENCES,
  EVENT_CATEGORIES,
  eventMatchesPreferences,
  type EventCategory,
  type UserPreferencesView,
} from './lib/preferences';
import { NotAuthenticatedError } from './lib/session';
import { fetchFolders } from './lib/folders-api.ts';

const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function calendarDays(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - mondayOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function calendarRange(month: Date) {
  const days = calendarDays(month);
  return { from: toDateKey(days[0]!), to: toDateKey(days.at(-1)!) };
}

function eventDisplayDateKey(event: CalendarEventView, viewerTimeZone: string) {
  if (event.allDay || !event.startAt) return event.eventDate;
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: viewerTimeZone,
  }).formatToParts(new Date(event.startAt));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function formatMonth(month: Date) {
  return new Intl.DateTimeFormat('en-SG', {
    month: 'long',
    year: 'numeric',
  }).format(month);
}

function formatTime(event: CalendarEventView, viewerTimeZone: string) {
  if (event.allDay || !event.startAt) return 'All day';

  return new Intl.DateTimeFormat('en-SG', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: viewerTimeZone,
  }).format(new Date(event.startAt));
}

function formatLongDate(event: CalendarEventView, viewerTimeZone: string) {
  if (!event.allDay && event.startAt) {
    return new Intl.DateTimeFormat('en-SG', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: viewerTimeZone,
    }).format(new Date(event.startAt));
  }
  const [year, month, day] = event.eventDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-SG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function statusLabel(status: EventReviewStatus) {
  if (status === 'unconfirmed') return 'Needs review';
  if (status === 'confirmed') return 'Accepted';
  return 'Removed';
}

function toLocalDateTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIsoInstant(value: string) {
  return value ? new Date(value).toISOString() : null;
}

interface WebMcpContext {
  registerTool(
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute(input: unknown): Promise<unknown>;
    },
    options: { signal: AbortSignal },
  ): void | Promise<void>;
}

export default function Home() {
  const [activeMonth, setActiveMonth] = useState(() => new Date(2026, 8, 1));
  const [events, setEvents] = useState<CalendarEventView[]>(
    isDemoMode ? demoEvents : [],
  );
  const [selectedEventId, setSelectedEventId] = useState<string | null>(
    isDemoMode ? 'noc-sharing' : null,
  );
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unconfirmed'>('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(!isDemoMode);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [correction, setCorrection] = useState<EventCorrection | null>(null);
  const [viewerTimeZone, setViewerTimeZone] = useState('UTC');
  const [todayKey, setTodayKey] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<UserPreferencesView>(DEFAULT_PREFERENCES);
  const [preferenceDraft, setPreferenceDraft] = useState<UserPreferencesView>(DEFAULT_PREFERENCES);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [locationDraft, setLocationDraft] = useState('');
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [preferencesSaving, setPreferencesSaving] = useState(false);

  const preferenceFilteredEvents = useMemo(
    () => isDemoMode ? events.filter((event) => eventMatchesPreferences(event, preferences)) : events,
    [events, preferences],
  );

  const range = useMemo(() => calendarRange(activeMonth), [activeMonth]);
  const sources = useMemo(
    () => Array.from(new Set(preferenceFilteredEvents.map((event) => event.sourceLabel).filter((value): value is string => Boolean(value)))).sort(),
    [preferenceFilteredEvents],
  );

  const loadEvents = useCallback(async () => {
    if (isDemoMode) return;

    setIsLoading(true);
    setLoadError(null);
    try {
      const nextEvents = await fetchEvents(range.from, range.to);
      setEvents(nextEvents);
      setSelectedEventId((current) => {
        if (current && nextEvents.some((event) => event.id === current)) {
          return current;
        }
        return nextEvents.find((event) => event.status === 'unconfirmed')?.id ?? null;
      });
    } catch (error) {
      // An expired or missing session is not an error to display — it means the
      // user needs to connect their Telegram account.
      if (error instanceof NotAuthenticatedError) {
        window.location.assign('/login');
        return;
      }
      setLoadError(error instanceof Error ? error.message : 'Could not load events.');
    } finally {
      setIsLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadEvents(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadEvents]);

  // Without a folder there is nothing to sync, so an empty calendar would be
  // misleading. Send the user to pick one instead.
  useEffect(() => {
    if (isDemoMode) return;
    const timeout = window.setTimeout(() => {
      void fetchFolders()
        .then((response) => {
          if (!response.selected) window.location.assign('/setup');
        })
        .catch(() => {
          // Folder state is a nicety; never block the calendar on it.
        });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (isDemoMode) return;
    const timeout = window.setTimeout(() => {
      void fetchPreferences()
        .then((next) => {
          setPreferences(next);
          setPreferenceDraft(next);
        })
        .catch((error: unknown) => setLoadError(
          error instanceof Error ? error.message : 'Could not load preferences.',
        ));
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setViewerTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
      setTodayKey(toDateKey(new Date()));
      if (!isDemoMode) setActiveMonth(new Date());
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const visibleEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return preferenceFilteredEvents.filter((event) => {
      if (event.status === 'dismissed') return false;
      if (statusFilter === 'unconfirmed' && event.status !== 'unconfirmed') {
        return false;
      }
      if (sourceFilter !== 'all' && event.sourceLabel !== sourceFilter) return false;
      if (!normalizedQuery) return true;

      return [event.title, event.locationName, event.sourceLabel]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [preferenceFilteredEvents, query, sourceFilter, statusFilter]);

  const days = useMemo(() => calendarDays(activeMonth), [activeMonth]);
  const eventsByDay = useMemo(() => {
    return visibleEvents.reduce<Record<string, CalendarEventView[]>>((groups, event) => {
      const dateKey = eventDisplayDateKey(event, viewerTimeZone);
      (groups[dateKey] ??= []).push(event);
      return groups;
    }, {});
  }, [viewerTimeZone, visibleEvents]);

  const reviewEvents = preferenceFilteredEvents.filter((event) => event.status === 'unconfirmed');
  const selectedEvent = preferenceFilteredEvents.find((event) => event.id === selectedEventId) ?? null;

  function openPreferences() {
    setPreferenceDraft({
      interestCategories: [...preferences.interestCategories],
      locationTerms: [...preferences.locationTerms],
    });
    setLocationDraft('');
    setPreferencesError(null);
    setPreferencesOpen(true);
  }

  function toggleInterest(category: EventCategory) {
    setPreferenceDraft((current) => ({
      ...current,
      interestCategories: current.interestCategories.includes(category)
        ? current.interestCategories.filter((item) => item !== category)
        : [...current.interestCategories, category],
    }));
  }

  function addLocation() {
    const location = locationDraft.trim();
    if (!location) return;
    if (preferenceDraft.locationTerms.some((item) => item.toLocaleLowerCase() === location.toLocaleLowerCase())) {
      setLocationDraft('');
      return;
    }
    setPreferenceDraft((current) => ({
      ...current,
      locationTerms: [...current.locationTerms, location],
    }));
    setLocationDraft('');
  }

  async function persistPreferences() {
    if (preferenceDraft.interestCategories.length === 0) {
      setPreferencesError('Choose at least one interest.');
      return;
    }
    setPreferencesSaving(true);
    setPreferencesError(null);
    try {
      const saved = isDemoMode ? preferenceDraft : await savePreferences(preferenceDraft);
      setPreferences(saved);
      setPreferenceDraft(saved);
      setPreferencesOpen(false);
      setSelectedEventId(null);
      if (!isDemoMode) await loadEvents();
      setNotice('Preferences saved');
    } catch (error) {
      setPreferencesError(error instanceof Error ? error.message : 'Could not save preferences.');
    } finally {
      setPreferencesSaving(false);
    }
  }

  const reviewEvent = useCallback(async (
    event: CalendarEventView,
    status: Extract<EventReviewStatus, 'confirmed' | 'dismissed'>,
  ) => {
    const previousEvents = events;
    setUpdatingId(event.id);
    setEvents((current) =>
      current.map((item) => (item.id === event.id ? { ...item, status } : item)),
    );

    if (status === 'dismissed') {
      const nextReview = events.find(
        (item) => item.status === 'unconfirmed' && item.id !== event.id,
      );
      setSelectedEventId(nextReview?.id ?? null);
    }

    try {
      if (!isDemoMode) {
        await updateEventStatus(event.id, status);
      }
      setNotice(status === 'confirmed' ? 'Event accepted' : 'Event removed');
      return { ok: true as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'That update did not save.';
      setEvents(previousEvents);
      setSelectedEventId(event.id);
      setNotice(message);
      return { ok: false as const, error: message };
    } finally {
      setUpdatingId(null);
    }
  }, [events]);

  function beginCorrection(event: CalendarEventView) {
    setEditingEventId(event.id);
    setCorrection({
      title: event.title,
      eventDate: event.eventDate,
      startAt: toLocalDateTime(event.startAt),
      endAt: toLocalDateTime(event.endAt),
      allDay: event.allDay,
      locationName: event.locationName,
      address: event.address,
      rsvpUrl: event.rsvpUrl,
    });
  }

  async function saveCorrection() {
    if (!editingEventId || !correction || !correction.title.trim() || !correction.eventDate) return;
    const event = events.find((item) => item.id === editingEventId);
    if (!event) return;

    const payload: EventCorrection = {
      ...correction,
      title: correction.title.trim(),
      startAt: correction.allDay ? null : toIsoInstant(correction.startAt ?? ''),
      endAt: correction.allDay ? null : toIsoInstant(correction.endAt ?? ''),
      locationName: correction.locationName?.trim() || null,
      address: correction.address?.trim() || null,
      rsvpUrl: correction.rsvpUrl?.trim() || null,
    };

    setUpdatingId(event.id);
    try {
      const updated = isDemoMode
        ? { ...event, ...payload }
        : await correctEvent(event.id, payload);
      setEvents((current) => current.map((item) => (item.id === event.id ? updated : item)));
      setNotice('Changes saved');
      setEditingEventId(null);
      setCorrection(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That correction did not save.');
    } finally {
      setUpdatingId(null);
    }
  }

  useEffect(() => {
    const modelContext = (
      document as Document & { modelContext?: WebMcpContext }
    ).modelContext;
    if (!modelContext?.registerTool) return;

    const lifecycle = new AbortController();
    const registerReviewTool = (
      name: 'accept_event' | 'remove_event',
      status: 'confirmed' | 'dismissed',
      title: string,
      description: string,
    ) => {
      void Promise.resolve(modelContext.registerTool({
        name,
        title,
        description,
        inputSchema: {
          type: 'object',
          properties: { eventId: { type: 'string' } },
          required: ['eventId'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          const eventId =
            typeof input === 'object' && input !== null && 'eventId' in input
              ? (input as { eventId?: unknown }).eventId
              : null;
          if (typeof eventId !== 'string' || !eventId) {
            throw new Error('eventId must be a non-empty string.');
          }

          const event = events.find((item) => item.id === eventId);
          if (!event || event.status !== 'unconfirmed') {
            throw new Error('That event is not waiting for review.');
          }

          const result = await reviewEvent(event, status);
          if (!result.ok) throw new Error(result.error);
          return { eventId, status };
        },
      }, { signal: lifecycle.signal })).catch(() => undefined);
    };

    registerReviewTool(
      'accept_event',
      'confirmed',
      'Accept calendar event',
      'Accept one event that is currently waiting for review and save the decision.',
    );
    registerReviewTool(
      'remove_event',
      'dismissed',
      'Remove calendar event',
      'Dismiss one event that is currently waiting for review and save the decision.',
    );

    return () => lifecycle.abort();
  }, [events, reviewEvent]);

  function changeMonth(offset: number) {
    setActiveMonth((current) =>
      new Date(current.getFullYear(), current.getMonth() + offset, 1),
    );
  }

  function goToCurrentMonth() {
    setActiveMonth(isDemoMode ? new Date(2026, 8, 1) : new Date());
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="easycal home">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>easycal</span>
        </a>
        <nav className="primary-nav" aria-label="Primary navigation">
          <a className="nav-link active" href="#calendar" aria-current="page">Calendar</a>
          <a className="nav-link" href="#review">
            Review
            {reviewEvents.length > 0 && <span className="nav-count">{reviewEvents.length}</span>}
          </a>
        </nav>
        <div className="account-area">
          <span className={`connection-dot ${isDemoMode ? 'demo' : ''}`} aria-hidden="true" />
          <span className="connection-label">{isDemoMode ? 'Preview mode' : 'Synced'}</span>
          <button className="avatar" type="button" aria-label="Open account menu">JJ</button>
        </div>
      </header>

      <div className="page" id="top">
        <section className="page-heading" aria-labelledby="calendar-heading">
          <div>
            <p className="eyebrow">Your calendar</p>
            <div className="title-row">
              <h1 id="calendar-heading">{formatMonth(activeMonth)}</h1>
              {reviewEvents.length > 0 && (
                <button
                  className="review-pill"
                  type="button"
                  onClick={() => {
                    setStatusFilter('unconfirmed');
                    document.querySelector('#review')?.scrollIntoView({ behavior: 'smooth' });
                  }}
                >
                  <span aria-hidden="true" />
                  {reviewEvents.length} to review
                </button>
              )}
            </div>
            <p className="subheading">Events found in your Telegram folders, ready when you are.</p>
          </div>
          <div className="month-controls" aria-label="Calendar navigation">
            <button type="button" onClick={() => changeMonth(-1)} aria-label="Previous month">←</button>
            <button className="today-button" type="button" onClick={goToCurrentMonth}>This month</button>
            <button type="button" onClick={() => changeMonth(1)} aria-label="Next month">→</button>
          </div>
        </section>

        <section className="toolbar" aria-label="Calendar filters">
          <label className="search-field">
            <span className="search-icon" aria-hidden="true" />
            <span className="sr-only">Search events</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search events, places, sources…"
            />
          </label>
          <label className="source-select">
            <span className="sr-only">Filter by source</span>
            <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
              <option value="all">All sources</option>
              {sources.map((source) => <option value={source} key={source}>{source}</option>)}
            </select>
          </label>
          <div className="filter-tabs" aria-label="Event status filter">
            <button
              className={statusFilter === 'all' ? 'active' : ''}
              type="button"
              onClick={() => setStatusFilter('all')}
              aria-pressed={statusFilter === 'all'}
            >All events</button>
            <button
              className={statusFilter === 'unconfirmed' ? 'active' : ''}
              type="button"
              onClick={() => setStatusFilter('unconfirmed')}
              aria-pressed={statusFilter === 'unconfirmed'}
            >Needs review</button>
          </div>
          <button className="preferences-button" type="button" onClick={openPreferences}>
            <span aria-hidden="true">☷</span>
            Preferences
          </button>
          <Link
            className="export-button"
            href="/setup"
            title="Choose which Telegram folder EasyCal reads"
          >
            Folder
          </Link>
          <a
            className={`export-button ${isDemoMode ? 'is-disabled' : ''}`}
            href={isDemoMode ? undefined : icsDownloadUrl(range.from, range.to)}
            aria-disabled={isDemoMode}
            onClick={(event) => {
              event.preventDefault();
              if (isDemoMode) {
                setNotice('ICS export will activate when the API is connected.');
                return;
              }
              // The download must be fetched with the session header, so it cannot
              // be a plain link navigation.
              void downloadIcs(range.from, range.to).catch((error: unknown) => {
                setNotice(error instanceof Error ? error.message : 'Could not export the calendar.');
              });
            }}
          >
            <span className="download-icon" aria-hidden="true">↓</span>
            Export .ics
          </a>
        </section>

        {loadError && (
          <div className="error-banner" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={() => void loadEvents()}>Try again</button>
          </div>
        )}

        <div className="calendar-layout">
          <section className="calendar-card" id="calendar" aria-label={`${formatMonth(activeMonth)} calendar`}>
            <div className="weekday-row" aria-hidden="true">
              {weekdayLabels.map((weekday) => <div key={weekday}>{weekday}</div>)}
            </div>
            <div className="calendar-grid">
              {days.map((date) => {
                const dateKey = toDateKey(date);
                const dayEvents = eventsByDay[dateKey] ?? [];
                const isOutsideMonth = date.getMonth() !== activeMonth.getMonth();
                const isToday = dateKey === todayKey;

                return (
                  <div className={`day-cell ${isOutsideMonth ? 'outside-month' : ''}`} key={dateKey}>
                    <time className={isToday ? 'today' : ''} dateTime={dateKey}>{date.getDate()}</time>
                    <div className="day-events">
                      {dayEvents.slice(0, 3).map((event) => (
                        <button
                          className={`calendar-event ${event.status}`}
                          type="button"
                          key={event.id}
                          onClick={() => setSelectedEventId(event.id)}
                          aria-label={`${event.title}, ${formatTime(event, viewerTimeZone)}, ${statusLabel(event.status)}`}
                        >
                          <span className="event-time">{formatTime(event, viewerTimeZone)}</span>
                          <span className="event-title">{event.title}</span>
                          {event.status === 'unconfirmed' && (
                            <span className="event-review-dot" aria-label="Needs review" />
                          )}
                        </button>
                      ))}
                      {dayEvents.length > 3 && <span className="more-events">+{dayEvents.length - 3} more</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            {!isLoading && visibleEvents.length === 0 && (
              <div className="calendar-empty">
                <strong>No matching events</strong>
                <span>Try broadening your interests or preferred locations.</span>
                <button type="button" onClick={openPreferences}>Edit preferences</button>
              </div>
            )}
            {isLoading && <div className="calendar-loading" role="status">Loading your calendar…</div>}
          </section>

          <aside className="review-panel" id="review" aria-labelledby="review-heading">
            <div className="panel-header">
              <div><p className="eyebrow">Inbox</p><h2 id="review-heading">Needs review</h2></div>
              <span className="panel-count">{reviewEvents.length}</span>
            </div>

            {reviewEvents.length > 0 ? (
              <div className="review-list">
                {reviewEvents.map((event) => {
                  const displayDate = eventDisplayDateKey(event, viewerTimeZone);
                  return (
                  <button
                    type="button"
                    className={`review-list-item ${selectedEventId === event.id ? 'selected' : ''}`}
                    key={event.id}
                    onClick={() => setSelectedEventId(event.id)}
                  >
                    <span className="review-date">
                      <strong>{displayDate.slice(8)}</strong>
                      {new Intl.DateTimeFormat('en-SG', { month: 'short' })
                        .format(new Date(`${displayDate}T12:00:00`)).toUpperCase()}
                    </span>
                    <span className="review-summary">
                      <strong>{event.title}</strong>
                      <small>{formatTime(event, viewerTimeZone)} · {event.sourceLabel ?? 'Unknown source'}</small>
                    </span>
                    <span className="chevron" aria-hidden="true">›</span>
                  </button>
                  );
                })}
              </div>
            ) : (
              <div className="empty-review">
                <span className="empty-check" aria-hidden="true">✓</span>
                <h3>All caught up</h3>
                <p>There are no new events waiting for your review.</p>
              </div>
            )}

            {selectedEvent && selectedEvent.status !== 'dismissed' && (
              <article className="event-detail" aria-live="polite">
                <div className="detail-status">
                  <span className={selectedEvent.status} aria-hidden="true" />
                  {statusLabel(selectedEvent.status)}
                </div>
                <h3>{selectedEvent.title}</h3>
                <p className="detail-description">{selectedEvent.description}</p>
                <div className="category-list" aria-label="Event categories">
                  {selectedEvent.categories.map((category) => (
                    <span key={category}>{CATEGORY_LABELS[category]}</span>
                  ))}
                </div>
                <dl>
                  <div>
                    <dt><span aria-hidden="true">◷</span><span className="sr-only">When</span></dt>
                    <dd>
                      <strong>{formatLongDate(selectedEvent, viewerTimeZone)}</strong>
                      <span>{formatTime(selectedEvent, viewerTimeZone)} · {viewerTimeZone.replace('_', ' ')}</span>
                    </dd>
                  </div>
                  {selectedEvent.locationName && (
                    <div>
                      <dt><span aria-hidden="true">⌖</span><span className="sr-only">Where</span></dt>
                      <dd>
                        <strong>{selectedEvent.locationName}</strong>
                        {selectedEvent.address && <span>{selectedEvent.address}</span>}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt><span aria-hidden="true">↗</span><span className="sr-only">Source</span></dt>
                    <dd><strong>{selectedEvent.sourceLabel ?? 'Telegram'}</strong><span>Found in your synced folder</span></dd>
                  </div>
                </dl>

                {selectedEvent.rsvpUrl && (
                  <a className="rsvp-link" href={selectedEvent.rsvpUrl} target="_blank" rel="noreferrer">
                    View RSVP page <span aria-hidden="true">↗</span>
                  </a>
                )}

                {selectedEvent.status === 'unconfirmed' && (
                  <div className="review-actions">
                    <button
                      className="remove-button"
                      type="button"
                      disabled={updatingId === selectedEvent.id}
                      onClick={() => void reviewEvent(selectedEvent, 'dismissed')}
                    >Remove</button>
                    <button
                      className="correct-button"
                      type="button"
                      disabled={updatingId === selectedEvent.id}
                      onClick={() => beginCorrection(selectedEvent)}
                    >Edit</button>
                    <button
                      className="accept-button"
                      type="button"
                      disabled={updatingId === selectedEvent.id}
                      onClick={() => void reviewEvent(selectedEvent, 'confirmed')}
                    >
                      <span aria-hidden="true">✓</span>
                      {updatingId === selectedEvent.id ? 'Saving…' : 'Accept event'}
                    </button>
                  </div>
                )}
                {selectedEvent.status === 'confirmed' && (
                  <div className="confirmed-actions">
                    <button className="correct-button" type="button" onClick={() => beginCorrection(selectedEvent)}>Edit details</button>
                    <button className="remove-button" type="button" onClick={() => void reviewEvent(selectedEvent, 'dismissed')}>Dismiss</button>
                  </div>
                )}
              </article>
            )}
          </aside>
        </div>

        <footer className="page-footer">
          <p>
            <span className={`connection-dot ${isDemoMode ? 'demo' : ''}`} aria-hidden="true" />
            {isDemoMode
              ? 'Showing safe demo data. Add NEXT_PUBLIC_API_BASE_URL to connect the backend.'
              : 'Calendar is connected to easycal.'}
          </p>
          <span>Times shown in your local timezone</span>
        </footer>
      </div>

      {notice && <div className="toast" role="status">{notice}</div>}
      {editingEventId && correction && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="correction-dialog"
            aria-labelledby="correction-title"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCorrection();
            }}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">Review extraction</p>
                <h2 id="correction-title">Edit event details</h2>
              </div>
              <button
                className="dialog-close"
                type="button"
                aria-label="Close correction form"
                onClick={() => {
                  setEditingEventId(null);
                  setCorrection(null);
                }}
              >×</button>
            </div>

            <div className="correction-fields">
              <label className="field field-wide">
                <span>Title</span>
                <input required value={correction.title} onChange={(event) => setCorrection({ ...correction, title: event.target.value })} />
              </label>
              <label className="field">
                <span>Date</span>
                <input required type="date" value={correction.eventDate} onChange={(event) => setCorrection({ ...correction, eventDate: event.target.value })} />
              </label>
              <label className="all-day-field">
                <input
                  type="checkbox"
                  checked={correction.allDay}
                  onChange={(event) => setCorrection({
                    ...correction,
                    allDay: event.target.checked,
                    startAt: event.target.checked ? null : correction.startAt,
                    endAt: event.target.checked ? null : correction.endAt,
                  })}
                />
                <span>All-day event</span>
              </label>
              {!correction.allDay && (
                <>
                  <label className="field">
                    <span>Starts</span>
                    <input required type="datetime-local" value={correction.startAt ?? ''} onChange={(event) => setCorrection({ ...correction, startAt: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>Ends</span>
                    <input type="datetime-local" value={correction.endAt ?? ''} onChange={(event) => setCorrection({ ...correction, endAt: event.target.value })} />
                  </label>
                </>
              )}
              <label className="field field-wide">
                <span>Venue</span>
                <input value={correction.locationName ?? ''} onChange={(event) => setCorrection({ ...correction, locationName: event.target.value })} />
              </label>
              <label className="field field-wide">
                <span>Address</span>
                <input value={correction.address ?? ''} onChange={(event) => setCorrection({ ...correction, address: event.target.value })} />
              </label>
              <label className="field field-wide">
                <span>RSVP URL</span>
                <input type="url" value={correction.rsvpUrl ?? ''} onChange={(event) => setCorrection({ ...correction, rsvpUrl: event.target.value })} />
              </label>
            </div>

            <div className="dialog-actions">
              <button type="button" onClick={() => { setEditingEventId(null); setCorrection(null); }}>Cancel</button>
              <button className="save-button" type="submit" disabled={updatingId === editingEventId}>
                {updatingId === editingEventId ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </div>
      )}
      {preferencesOpen && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="correction-dialog preferences-dialog"
            aria-labelledby="preferences-title"
            onSubmit={(event) => {
              event.preventDefault();
              void persistPreferences();
            }}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">Keep the signal</p>
                <h2 id="preferences-title">Your preferences</h2>
              </div>
              <button className="dialog-close" type="button" aria-label="Close preferences" onClick={() => setPreferencesOpen(false)}>×</button>
            </div>
            <p className="preferences-intro">Only events matching at least one interest will reach your calendar.</p>
            <fieldset className="preference-group">
              <legend>Interests</legend>
              <div className="interest-grid">
                {EVENT_CATEGORIES.filter((category) => category !== 'other').map((category) => {
                  const selected = preferenceDraft.interestCategories.includes(category);
                  return (
                    <button
                      key={category}
                      type="button"
                      className={selected ? 'selected' : ''}
                      aria-pressed={selected}
                      onClick={() => toggleInterest(category)}
                    >
                      <span aria-hidden="true">{selected ? '✓' : '+'}</span>
                      {CATEGORY_LABELS[category]}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <fieldset className="preference-group">
              <legend>Preferred locations <small>optional</small></legend>
              <p>Leave empty to see matching interests anywhere.</p>
              {preferenceDraft.locationTerms.length > 0 && (
                <div className="location-chips">
                  {preferenceDraft.locationTerms.map((location) => (
                    <button
                      key={location}
                      type="button"
                      onClick={() => setPreferenceDraft((current) => ({
                        ...current,
                        locationTerms: current.locationTerms.filter((item) => item !== location),
                      }))}
                    >
                      {location} <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="location-input">
                <input
                  value={locationDraft}
                  maxLength={80}
                  placeholder="e.g. NUS, Kent Ridge, online"
                  aria-label="Add preferred location"
                  onChange={(event) => setLocationDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addLocation();
                    }
                  }}
                />
                <button type="button" onClick={addLocation}>Add</button>
              </div>
            </fieldset>
            {preferencesError && <p className="preferences-error" role="alert">{preferencesError}</p>}
            <div className="dialog-actions">
              <button type="button" onClick={() => setPreferencesOpen(false)}>Cancel</button>
              <button className="save-button" type="submit" disabled={preferencesSaving}>
                {preferencesSaving ? 'Saving…' : 'Save preferences'}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
