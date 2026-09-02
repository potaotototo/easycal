# Sync worker

Telegram synchronization and scheduled jobs. Owned by Person A (`docs/workstreams.md`).

## Responsibilities

- Resolve the selected Telegram folder on **every** run, so newly joined or muted channels are
  picked up automatically.
- Fetch `folder_selections.lookback_days` plus `SYNC_OVERLAP_HOURS` of history, and upsert into
  `raw_messages` keyed on `(connection_id, source_chat_id, telegram_message_id)`.
- Record a `sync_runs` row per run and advance `sync_cursors` per chat.
- Back off on `FLOOD_WAIT`; mark a connection `reauth_required` on auth errors rather than
  failing silently.
- Assemble message chains, call the parser through the `EventParser` contract, and persist
  candidates and evidence.

## Telegram access seam

Telegram is reached through a `TelegramPort` interface with two implementations: the real GramJS
client, and a `FakeTelegramPort` seeded from `fixtures/`. Tests and the acceptance check run
against the fake, so no live Telegram account is needed to verify the pipeline.

## Swapping in the real parser

The worker depends only on the `EventParser` interface in `src/parser/contract.ts`, never on an
implementation. `StubEventParser` stands in until Person B ships `packages/event-parser`;
replacing it is one line in `src/index.ts`.

Two things to agree with Person B before that swap:

1. **Move the interface into `packages/contracts/src/parser.ts`.** It lives in the worker only
   because `packages/contracts` is shared and changes there are reviewed jointly.
2. **`description` is published.** `ShareSnapshotEvent` extends `CalendarEvent`, so whatever the
   parser writes into `description` appears in public share links. It must be a summary the
   parser authored — never the message body, which is private evidence. The stub sets it to
   `null` for exactly this reason, and `publicPayload.test.ts` guards the boundary.

`src/__fixtures__/messages.ts` is a stand-in for `fixtures/noc-sharing.input.json`, which Person
B owns and has not shipped (only the expected output exists). Delete it once the shared fixture
lands.

## Scheduling

Runs live in the `sync_runs` table, so an interrupted worker resumes rather than losing work:

- every 5s it claims one queued run (`for update skip locked`, safe with multiple workers);
- every `SYNC_INTERVAL_MINUTES` (default 15) it queues a run per active connection.

`POST /v1/sync-runs` simply inserts a queued row, so the API never needs to reach Telegram.
