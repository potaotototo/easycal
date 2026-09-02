# EasyCal

Ever muted Telegram channels because there is too much spam, then realised you missed an event or job posting? EasyCal takes away the chore of reading every message and surfaces the opportunities that matter.

An event-calendar service that lets a person authorize their Telegram account, choose a dynamic chat folder, extract events from recent English messages, and view or share an immutable calendar snapshot.

## Repository layout

- `apps/api` — authenticated HTTP API and share-link endpoints
- `apps/worker` — Telegram synchronization and scheduled jobs
- `apps/web` — private calendar and public snapshot UI (including the ChatGPT Site-facing frontend)
- `packages/contracts` — shared TypeScript models and API payload shapes
- `packages/event-parser` — message-chain assembly and event extraction
- `db/schema.sql` — initial PostgreSQL data model
- `docs` — architecture and file ownership plan
- `fixtures` — agreed parser examples

## Local development

Requires Node 22+ and pnpm (`corepack enable pnpm`). No Docker needed.

```sh
pnpm install
pnpm db                          # embedded Postgres 17, foreground (Ctrl-C to stop)
pnpm migrate                     # in another terminal
pnpm --filter @easycal/api dev   # http://localhost:3000/health
```

Copy `.env.example` to `.env` and fill it in. `pnpm build`, `pnpm typecheck`, and `pnpm test` all
run without a database. See [db/README.md](db/README.md) for database details.

Read [the architecture](docs/architecture.md) and [the two-person work plan](docs/workstreams.md) before implementation.

## Product decisions locked for v1

- Each user authorizes their own Telegram account and selects one dynamic folder.
- Sync only the last configurable `X` days (default 7), with a short overlap for edits/chains.
- English extraction only.
- An event with a date but no time is an all-day event.
- The original Telegram message is private evidence; it is never exposed through public sharing.
- Share links are public bearer URLs, read-only, immutable snapshots, and revocable.
- Calendar filtering is structured in v1; natural-language questions are deferred.
