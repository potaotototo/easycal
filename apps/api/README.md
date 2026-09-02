# API service

Authenticated HTTP API, Telegram onboarding, and the public share-snapshot endpoints.
Owned by Person A (`docs/workstreams.md`).

## Running locally

```sh
pnpm db                          # start Postgres (foreground; see db/README.md)
pnpm migrate                     # in another terminal, apply db/migrations
pnpm --filter @easycal/api dev
curl localhost:3000/health
```

No Docker required — `pnpm db` runs an embedded Postgres 17 out of `node_modules`.

Configuration comes from the repo-root `.env`; copy `.env.example` and fill it in.

## Identity model

The Telegram account **is** the app identity — there is no separate signup. Completing the
MTProto login both creates the `users` row (matched on `telegram_user_id`) and issues the app
session recorded in `user_sessions`.

Because the login is multi-step, it is modelled as a short-lived attempt:

1. `POST /v1/auth/telegram/start` — sends the code, returns an opaque `attemptId`.
2. `POST /v1/auth/telegram/verify` — code plus optional 2FA password, then session issued.

### Known constraint

An in-progress login attempt holds a live GramJS client in memory, so **v1 runs a single API
instance** (or requires sticky sessions). Moving attempts to shared storage is deliberately
out of scope for v1.

## Security invariants

- The API only ever *encrypts* Telegram session material. Only the worker decrypts it.
- Every `/v1` route is scoped to the authenticated user in the repository layer, not just
  in the handler.
- Session strings, bearer tokens, and raw message text are redacted from logs (`src/server.ts`).

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/auth/telegram/start` | Begin authorization; returns an `attemptId`, never session material. |
| `POST /v1/auth/telegram/verify` | Code + optional 2FA password. Creates the user, stores the encrypted session, issues a session cookie. `409 password_required` means retry with the password. |
| `POST /v1/auth/logout` | Revoke the current session. |
| `GET /v1/me` | Current user and Telegram connection status. |
| `GET /v1/folders` | Cached folder list plus the current selection. |
| `PUT /v1/folder-selection` | Choose a folder and lookback window. |
| `POST /v1/sync-runs` | Queue an on-demand sync. Rate limited to one per connection per minute (`429` + `retry-after`). |
| `GET /v1/events` | Filter by `from`, `to`, `sourceChatId`, `q`, `limit`. |
| `GET /v1/events/:id` | One event. |
| `PATCH /v1/events/:id` | `{"action":"dismiss"}` or `{"action":"correct", ...}`. |
| `GET /v1/events.ics` | Same filters, as an ICS download. |
| `POST /v1/share-snapshots` | Copy events into an immutable snapshot. The token is returned **once**. |
| `GET /v1/share-snapshots` | List your snapshots. |
| `DELETE /v1/share-snapshots/:id` | Revoke a snapshot. |
| `GET /s/:token` | Public, read-only, `noindex`. Serves copied payloads only. |

Authenticate with the `easycal_session` cookie, or `Authorization: Bearer <token>` for
non-browser clients.

### Why folders are cached

`GET /v1/folders` reads the `telegram_folders` table rather than asking Telegram. The API is
given an **encrypt-only** key provider, so it cannot decrypt a stored session to make that call.
The cache is written twice: by the API immediately after login, while it still holds a live
authenticated client, and by the worker on every sync run.
