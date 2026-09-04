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

- Handles application authentication and Telegram-connection onboarding. Two sign-in
  methods: QR (the default — scanned from a device already signed in, as Telegram Web
  does) and phone number plus code. Both end in the same encrypted connection and app
  session, and both still require `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`, which
  identify the *application*, not the user.
- Returns a user's calendar, filter results, event details, and ICS files.
- Creates, revokes, and serves immutable public snapshot links.
- Does not hold an unencrypted Telegram session in request logs or browser responses.

### Sync worker

- Resolves the selected Telegram folder at every run, so newly joined/muted channels are included automatically.
- Fetches messages from the configured time window plus an overlap (recommend 24 hours).
- Upserts messages by `(connection_id, telegram_chat_id, telegram_message_id)`.
- Records a cursor/run result, handles rate limiting, and marks a connection as needing reauthentication rather than silently failing.

### Parser

Lives in `packages/event-parser` and is compiled to `dist/`, so the built worker can
load it under plain `node`. The worker reaches it through the `EventParser` interface
in `apps/worker/src/parser/contract.ts`, adapted in `parser/real.ts`; the sync engine
never depends on the parser's own shape.

- Builds a candidate chain from a message, its replies/forwards, and nearby related posts in the same channel.
- Retains text, entities, links, and source-message IDs as evidence.
- Runs deterministic marker/regex extraction first (`📅`, `📍`, `RSVP`, `sign up`) and then structured model extraction only if needed.
- Validates dates, time ranges, years, location, timezone, and RSVP URLs before publishing an event.

### Category classifier

Runs in the worker after extraction, assigning each candidate zero or more
`EventCategory` values. It calls a model when `OPENAI_API_KEY` is set and falls back to
deterministic keyword matching otherwise, so sync never depends on model availability.
Categories drive the user's preference filter; they are private and are not published
in share snapshots.

### Calendar / web UI

Deployed separately from the API — it targets Cloudflare Workers, so it is always a
different origin. Two consequences the code depends on: the API must allow that origin
via `WEB_ORIGINS`, and the browser session is carried as a bearer token rather than a
cookie, because a cross-site session cookie would be blocked by default.

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

The detailed shared payload shapes are in `packages/contracts/src/event.ts`. Current endpoint contract:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/auth/telegram/qr` | Begin QR authorization; returns an attempt id and a code to scan. |
| `GET /v1/auth/telegram/qr/:attemptId` | Poll a QR attempt: refreshed code, 2FA prompt, or the issued session. |
| `POST /v1/auth/telegram/qr/:attemptId/password` | Supply the 2FA password after a scan. |
| `POST /v1/auth/telegram/start` | Begin phone authorization; returns an attempt id, never session secrets. |
| `POST /v1/auth/telegram/verify` | Code plus optional 2FA password; creates the user and issues a session. |
| `POST /v1/auth/logout` | Revoke the current session. |
| `GET /v1/me` | Current user and Telegram connection status. |
| `GET /v1/folders` | List selectable Telegram folders after connection. |
| `PUT /v1/folder-selection` | Select folder and sync window. |
| `GET /v1/preferences` | Read category preferences. |
| `PUT /v1/preferences` | Update category preferences. |
| `POST /v1/sync-runs` | Trigger an on-demand sync (rate limited). |
| `GET /v1/events` | Return filtered private events and unconfirmed candidates. |
| `GET /v1/events/:id` | Return one event. |
| `PATCH /v1/events/:id` | Confirm, dismiss, or correct a candidate/event. |
| `GET /v1/events.ics` | Download filtered events as ICS. |
| `POST /v1/share-snapshots` | Copy selected event views to an immutable snapshot. |
| `GET /v1/share-snapshots` | List your snapshots. |
| `DELETE /v1/share-snapshots/:id` | Revoke a snapshot. |
| `GET /s/:token` | Public, read-only snapshot payload/view. |
| `GET /health` | Liveness plus a database round trip. |

Authenticate with the `easycal_session` cookie or `Authorization: Bearer <token>`.
The web app uses the bearer form; see the note under "Calendar / web UI".

## Security requirements

- Encrypt Telegram session data with managed key encryption; limit decrypt permission to the worker identity. *Implemented as AES-256-GCM behind a `KeyProvider` seam with the key supplied by `SESSION_ENCRYPTION_KEY`; a managed KMS drops in at that seam. The API is constructed with an encrypt-only view.*
- Keep source message text, chat IDs, and Telegram handles out of public snapshots by default.
- Use a random, non-sequential snapshot token; support revocation and noindex headers on public pages.
- Enforce per-user authorization on every private API query.
- Redact URLs, authorization data, and raw messages from logs and tracing.
- Keep a retention policy for raw messages; event evidence can be reduced to references after a configurable period. *Not yet implemented — raw messages are retained indefinitely.*
