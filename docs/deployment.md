# Deployment

EasyCal is two long-running Node services plus PostgreSQL, and a separately hosted
web app.

| Piece | What it is | Where it runs |
| --- | --- | --- |
| `postgres` | PostgreSQL 17 | container, or a managed database |
| `migrate` | one-shot `node-pg-migrate up`, exits when done | container |
| `api` | Fastify HTTP API | container, needs an inbound port |
| `worker` | Telegram sync loop, no inbound port | container |
| `apps/web` | Next/vinext UI | Cloudflare Workers, deployed separately |

`api` and `worker` share one image and differ only in their start command, so they
can never drift apart.

## 1. Credentials

Copy `.env.example` to `.env` and fill in:

```sh
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # SESSION_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # APP_SESSION_SECRET
```

- **`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`** — from <https://my.telegram.org/apps>.
  Required by both services in production.
- **`SESSION_ENCRYPTION_KEY`** — encrypts stored Telegram sessions. **Back this up.**
  Rotating it makes every stored session unreadable and forces everyone to reconnect.
- **`APP_SESSION_SECRET`** — signs app session tokens. Rotating it logs everyone out.
- **`WEB_ORIGINS`** — the deployed web origin, e.g. `https://easycal.example.workers.dev`.
  The browser cannot call the API without it.
- **`OPENAI_API_KEY`** — optional. Without it the worker falls back to keyword-based
  category matching; sync still works.

`.env` is gitignored. Never commit it. On a managed host, set these as secrets rather
than shipping the file.

In production (`NODE_ENV=production`, which the image sets) both services **refuse to
start** if a required secret is missing, rather than failing on the first user's login.

## 2. Run the stack

```sh
docker compose -f infra/docker-compose.yml --env-file .env up -d --build --wait
```

`--wait` returns only once the health checks pass. The `migrate` service runs to
completion first and both services depend on it, so nothing ever starts against an
unmigrated schema.

Verify:

```sh
curl localhost:3000/health                 # {"status":"ok"}
curl -i localhost:3000/v1/events           # 401 — auth is enforced
docker compose -f infra/docker-compose.yml logs worker | tail -3
```

Postgres is published on `127.0.0.1:5432` only, so it is not reachable from the
network. Compose builds its own internal `DATABASE_URL` from the `POSTGRES_*` values,
so the `DATABASE_URL` in `.env` can keep pointing at `localhost` for `pnpm db`
without the two conflicting.

### Using a managed database instead

Drop the `postgres` service and set `DATABASE_URL_INTERNAL` to your provider's
connection string. Keep the `migrate` service — it is how migrations get applied.

## 3. Deploy the web app

The UI needs the API's public URL at **build** time:

```sh
cd apps/web
NEXT_PUBLIC_API_BASE_URL=https://api.your-host.example pnpm build
pnpm exec wrangler deploy
```

Then add that web origin to `WEB_ORIGINS` and restart the API. Without it every
browser request fails CORS. Because the two are different origins, the browser
session is a bearer token rather than a cookie — a cross-site cookie would be
blocked by default.

## 4. Verify against real Telegram

Nothing above proves the Telegram integration works; the whole suite runs against a
fake. Work through [live-smoke-test.md](live-smoke-test.md) once, especially folder
resolution.

## Upgrades

```sh
git pull
docker compose -f infra/docker-compose.yml --env-file .env up -d --build --wait
```

New migrations are applied by the `migrate` service before the services restart.
Migrations are expected to be reversible; roll one back with:

```sh
docker compose -f infra/docker-compose.yml run --rm --workdir /app/db migrate \
  node node_modules/node-pg-migrate/bin/node-pg-migrate.mjs down -m migrations
```

## Operational notes

- **Run one API instance.** An in-progress Telegram login is held in memory between
  `/start` and `/verify`, so a second instance would break sign-in. The worker is safe
  to scale: runs are claimed with `for update skip locked`.
- **Back up the database and `SESSION_ENCRYPTION_KEY` together.** Restoring one
  without the other leaves every stored Telegram session undecryptable.
- **Raw messages are retained indefinitely.** The retention policy in
  `docs/architecture.md` is not implemented yet.
