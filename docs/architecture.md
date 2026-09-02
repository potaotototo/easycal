# Architecture

## System boundary

Telegram access must be made by an authenticated **user client** for the person who connected their account. The service must never attempt to access chats that this account cannot access. Telegram session material is encrypted at rest and is available only to the sync worker.

```text
Browser / ChatGPT Site UI
       │ private API or public snapshot API
       ▼
     API service ─────────────── PostgreSQL
       │                              ▲
       │ schedules / enqueues         │
       ▼                              │
 Telegram sync worker ── parser ──────┘
       │
       ▼
 Telegram user account + selected dynamic folder
```

## Components

### API service

- Handles application authentication and Telegram-connection onboarding.
- Returns a user's calendar, filter results, event details, and ICS files.
- Creates, revokes, and serves immutable public snapshot links.
- Does not hold an unencrypted Telegram session in request logs or browser responses.

### Sync worker

- Resolves the selected Telegram folder at every run, so newly joined/muted channels are included automatically.
- Fetches messages from the configured time window plus an overlap (recommend 24 hours).
- Upserts messages by `(connection_id, telegram_chat_id, telegram_message_id)`.
- Records a cursor/run result, handles rate limiting, and marks a connection as needing reauthentication rather than silently failing.

### Parser

- Builds a candidate chain from a message, its replies/forwards, and nearby related posts in the same channel.
- Retains text, entities, links, and source-message IDs as evidence.
- Runs deterministic marker/regex extraction first (`📅`, `📍`, `RSVP`, `sign up`) and then structured model extraction only if needed.
- Validates dates, time ranges, years, location, timezone, and RSVP URLs before publishing an event.

### Calendar / web UI

- Private view: date-range, source, title/keyword filtering, event detail, dismiss/correct controls, and ICS download.
- Public view: renders a fixed `ShareSnapshot`; it never queries the source user's current events or raw messages.

## Data and event lifecycle

1. A user chooses a folder and a sync window.
2. The worker reads the folder definition, resolves its current eligible chats, and synchronizes recent messages.
3. The parser assembles each candidate chain and creates an `EventCandidate` with evidence and confidence.
4. A candidate with a trusted absolute date becomes a `CalendarEvent`. Missing time means `all_day = true`.
5. Uncertain/no-date candidates remain unconfirmed. Dismissal prevents the same evidence from resurfacing.
6. A user can export selected events to ICS or create a snapshot. Snapshot event payloads are copied into `share_snapshot_events` and are immutable.

## Parsing rules

Store the original message and a normalized version. Markdown/HTML formatting is removed only from the normalized text; link entities are retained as `{ label, url, offset }`.

An exact date is required to create an event. Resolve the year from the source message's sent time and reject a date that is implausibly far in the past/future. When both a relative date (for example, `this Wednesday`) and an absolute date are present, they must agree or confidence is reduced.

For an address that confidently indicates the event's local timezone, interpret the start/end in that timezone and render in the viewer's device timezone. If no location timezone can be inferred, use the account's configured device timezone.

## API boundary

The detailed shared payload shapes are in `packages/contracts/src/event.ts`. Initial endpoint contract:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/telegram/connections` | Begin account authorization; never return session secrets. |
| `GET /v1/folders` | List selectable Telegram folders after connection. |
| `PUT /v1/folder-selection` | Select folder and sync window. |
| `POST /v1/sync-runs` | Trigger an on-demand sync (rate limited). |
| `GET /v1/events` | Return filtered private events. |
| `PATCH /v1/events/:id` | Dismiss or correct a candidate/event. |
| `GET /v1/events.ics` | Download filtered events as ICS. |
| `POST /v1/share-snapshots` | Copy selected event views to an immutable snapshot. |
| `GET /s/:token` | Public, read-only snapshot payload/view. |
| `DELETE /v1/share-snapshots/:id` | Revoke a snapshot. |

## Security requirements

- Encrypt Telegram session data with managed key encryption; limit decrypt permission to the worker identity.
- Keep source message text, chat IDs, and Telegram handles out of public snapshots by default.
- Use a random, non-sequential snapshot token; support revocation and noindex headers on public pages.
- Enforce per-user authorization on every private API query.
- Redact URLs, authorization data, and raw messages from logs and tracing.
- Keep a retention policy for raw messages; event evidence can be reduced to references after a configurable period.
