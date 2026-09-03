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

## The parser

The worker depends only on the `EventParser` interface in `src/parser/contract.ts`, never on an
implementation. `src/parser/real.ts` adapts Person B's `@easycal/event-parser` to it: the worker
assembles chains itself while walking a chat, so it calls `parseEvent` with the evidence directly
rather than using the parser's own `assembleMessageChain`.

Two things still worth agreeing with Person B:

1. **Move the interface into `packages/contracts/src/parser.ts`.** It lives in the worker only
   because `packages/contracts` is shared and changes there are reviewed jointly.
2. **`description` is published.** `ShareSnapshotEvent` derives from `CalendarEvent`, so whatever
   the parser writes into `description` appears in public share links. It must be a summary the
   parser authored — never the message body, which is private evidence. `publicPayload.test.ts`
   guards the boundary.

`src/__fixtures__/messages.ts` drives the sync tests with several chats and a reply chain, which
the single-message `fixtures/noc-sharing.input.json` does not cover. Its message text is kept in
the same shape as the shared fixture.

## Scheduling

Runs live in the `sync_runs` table, so an interrupted worker resumes rather than losing work:

- every 5s it claims one queued run (`for update skip locked`, safe with multiple workers);
- every `SYNC_INTERVAL_MINUTES` (default 15) it queues a run per active connection.

`POST /v1/sync-runs` simply inserts a queued row, so the API never needs to reach Telegram.
