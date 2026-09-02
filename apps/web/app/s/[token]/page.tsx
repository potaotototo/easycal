import { notFound } from 'next/navigation';
import Link from 'next/link';
import { demoEvents } from '../../lib/demo-events';
import {
  fetchPublicSnapshot,
  isDemoMode,
  type CalendarEventView,
  type PublicSnapshot,
} from '../../lib/events-api';

interface SnapshotPageProps {
  params: Promise<{ token: string }>;
}

function demoSnapshot(): PublicSnapshot {
  return {
    title: 'Opportunities worth showing up for',
    events: demoEvents
      .filter((event) => event.status === 'confirmed')
      .map((event) => ({
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
      })),
  };
}

function formatDate(event: Omit<CalendarEventView, 'status'>) {
  const [year, month, day] = event.eventDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-SG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function formatTime(event: Omit<CalendarEventView, 'status'>) {
  if (event.allDay || !event.startAt) return 'All day';
  return new Intl.DateTimeFormat('en-SG', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: event.timezone ?? 'UTC',
    timeZoneName: 'short',
  }).format(new Date(event.startAt));
}

export default async function SnapshotPage({ params }: SnapshotPageProps) {
  const { token } = await params;
  let snapshot: PublicSnapshot;

  if (isDemoMode) {
    if (token !== 'demo') notFound();
    snapshot = demoSnapshot();
  } else {
    try {
      snapshot = await fetchPublicSnapshot(token);
    } catch {
      notFound();
    }
  }

  return (
    <main className="snapshot-shell">
      <header className="snapshot-topbar">
        <Link className="brand" href="/" aria-label="EasyCal home">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>easycal</span>
        </Link>
        <span className="snapshot-badge">Read-only snapshot</span>
      </header>

      <div className="snapshot-page">
        <section className="snapshot-hero">
          <p className="eyebrow">Shared calendar</p>
          <h1>{snapshot.title}</h1>
          <p>A finalised collection shared from EasyCal. Event details may change on the organiser’s RSVP page.</p>
        </section>

        {snapshot.events.length > 0 ? (
          <section className="snapshot-events" aria-label="Shared events">
            {snapshot.events.map((event) => (
              <article className="snapshot-event" key={event.id}>
                <time className="snapshot-date" dateTime={event.eventDate}>
                  <strong>{event.eventDate.slice(8)}</strong>
                  {formatDate(event).replace(/^\d+\s/, '')}
                </time>
                <div className="snapshot-copy">
                  <h2>{event.title}</h2>
                  <p className="snapshot-meta">{formatTime(event)}</p>
                  {event.description && <p className="snapshot-description">{event.description}</p>}
                  {(event.locationName || event.address) && (
                    <p className="snapshot-location">{[event.locationName, event.address].filter(Boolean).join(' · ')}</p>
                  )}
                </div>
                {event.rsvpUrl && (
                  <a className="snapshot-rsvp" href={event.rsvpUrl} target="_blank" rel="noreferrer">
                    RSVP <span aria-hidden="true">↗</span>
                  </a>
                )}
              </article>
            ))}
          </section>
        ) : (
          <p className="snapshot-empty">No events have been added to this snapshot yet.</p>
        )}

        <footer className="snapshot-footer">Shared with EasyCal · No private messages or review notes are included.</footer>
      </div>
    </main>
  );
}
