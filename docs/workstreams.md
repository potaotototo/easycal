# Two-person work plan

## Shared rule

Agree on `packages/contracts` and `fixtures` before changing implementation. Each person owns their directories; avoid drive-by edits to the other person's work. Contract changes should be reviewed together because they affect every component.

## Person A — Telegram, API, persistence

Owns: `apps/api`, `apps/worker`, `db`, `infra`.

1. Set up PostgreSQL migrations from `db/schema.sql`.
2. Implement Telegram user-account authorization and encrypted connection storage.
3. Implement folder listing, dynamic-folder resolution, sync scheduling, cursors, deduplication, and retry/rate-limit handling.
4. Persist raw messages and invoke the parser through the contract boundary.
5. Implement private event queries, snapshot creation/revocation, and ICS generation.

Acceptance check: after choosing a folder, a test connection can sync fixture-equivalent messages, persist events, export ICS, and return a public snapshot with no raw-message content.

## Person B — Event parsing and calendar UI

Owns: `packages/event-parser`, `apps/web`, `fixtures`.

1. Build normalizer that preserves Telegram link entities while producing readable text.
2. Implement chain assembly and deterministic event extraction.
3. Add structured-model fallback with the `EventCandidate` contract; validate output before it can create a `CalendarEvent`.
4. Build private filters, event detail, correction/dismiss UI, and ICS download controls.
5. Build public read-only snapshot view; do not render private evidence.

Acceptance check: the NOC fixture produces one high-confidence timed event with the correct RSVP URL; a date-only fixture creates an all-day event; no-date fixtures remain unconfirmed.

## Integration milestones

| Milestone | Person A deliverable | Person B deliverable |
| --- | --- | --- |
| 1. Contract freeze | database adapter accepts contract objects | fixture inputs/expected outputs accepted |
| 2. Vertical slice | worker calls parser and persists result | parser produces candidate from fixture |
| 3. Calendar | `GET /v1/events` and ICS endpoint | private filter/calendar view |
| 4. Sharing | immutable snapshot API | public snapshot view |

## Explicit non-goals for v1

- Natural-language calendar queries.
- Non-English extraction.
- Syncing full Telegram history.
- Mutable or authenticated public sharing.
- Automatically creating Telegram posts or messages.
