# Work plan

EasyCal is developed solo. This file tracks what is built, what is left, and the
conventions worth keeping now that there is no second person to coordinate with.

Earlier versions of this file split the repository between two people. That split is
gone: every directory has the same owner, and `packages/contracts` and `fixtures` no
longer need a review handshake before they change.

## Status

| Area | State |
| --- | --- |
| PostgreSQL schema and migrations | Done |
| Telegram authorization, encrypted session storage | Done, never run against real Telegram |
| Folder listing, dynamic-folder resolution, sync scheduling, cursors, deduplication, rate-limit handling | Done, exercised against a fake Telegram |
| Raw message persistence, parser invoked through the contract boundary | Done, running the real parser |
| Private event queries, snapshot create/revoke, ICS generation | Done |
| Message normalization, chain assembly, deterministic extraction | Done |
| Structured-model fallback validated before it can create an event | Done |
| Category classification and preference filtering | Done |
| Calendar UI: filters, event detail, correct/dismiss, ICS download | Done |
| Public read-only snapshot view | Done |
| Deployment | **Not started** |
| Live Telegram verification | **Not done** |

## What is actually left

1. **Deploy.** Postgres, the API, and the worker need somewhere to run, migrations
   need to be applied there, and the web app needs to point at the deployed API.
   See [deployment.md](deployment.md).
2. **Run against real Telegram.** No Telegram-facing code has ever talked to
   Telegram. See [live-smoke-test.md](live-smoke-test.md). Folder resolution is the
   highest-risk part: it reimplements Telegram's filter semantics and a fake cannot
   validate it.

## Conventions worth keeping

- **`packages/contracts` is still the seam.** The API, worker, parser and web app all
  depend on those types. Changing a field there is still a change to four things at
  once, even with one person making it.
- **`toPublicPayload` is the only path to public data.** It is an explicit allowlist,
  not a spread, so a new column cannot leak into a share link by accident.
  `publicPayload.test.ts` enforces this.
- **Only the worker decrypts Telegram sessions.** The API is handed an encrypt-only
  key provider. Keep that split; it is why a compromised API cannot read sessions.
- **The parser is reached through `EventParser`** (`apps/worker/src/parser/contract.ts`),
  adapted in `parser/real.ts`. The sync engine does not know the parser's shape.
- **Telegram is reached through `TelegramPort`.** Every test and the acceptance check
  run against `FakeTelegramPort`, which is why the suite needs no network, no Docker
  and no Telegram account.

## Verification

```sh
pnpm db                  # embedded Postgres, foreground
pnpm migrate
pnpm test                # backend suites
pnpm --filter @easycal/event-parser test
pnpm --filter @easycal/web test
```

The acceptance check lives in `apps/worker/src/sync/acceptance.test.ts`: choose a
folder, sync fixture-equivalent messages, persist events, export ICS, and return a
public snapshot containing no raw-message content.

## Out of scope for v1

- Natural-language calendar queries.
- Non-English extraction.
- Syncing full Telegram history.
- Mutable or authenticated public sharing.
- Posting to Telegram.
