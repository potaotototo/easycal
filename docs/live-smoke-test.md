# Live Telegram smoke test (Person A)

Everything in the automated suite runs against a **fake** Telegram. This checklist covers what
only a real account can prove. Run it once before trusting the sync path.

You need an `api_id` and `api_hash` from <https://my.telegram.org/apps>, and a Telegram account
that is in at least one folder containing a channel that posts events.

## 0. Configure

```sh
cp .env.example .env   # if you have not already
```

Fill in `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and generate a key:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # SESSION_ENCRYPTION_KEY
```

## 1. Database and API

```sh
pnpm db          # terminal 1 — leave running
pnpm migrate     # terminal 2
pnpm --filter @easycal/api dev   # terminal 2 — leave running
curl -s localhost:3000/health    # {"status":"ok"}
```

## 1b. The web app (optional, but this is the real flow)

```sh
cd apps/web
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000 pnpm dev   # terminal 4
```

Open <http://localhost:3001/login> and sign in there instead of using curl below.
The app stores the returned session token and sends it as a bearer header; it is a
different origin from the API, so `WEB_ORIGINS` in `.env` must list it (it defaults
to `http://localhost:3001`).

- [ ] Visiting `/` while signed out redirects you to `/login`.
- [ ] After signing in, the calendar loads and the header reads "Synced".

## 2. Log in with your Telegram account

```sh
curl -s -X POST localhost:3000/v1/auth/telegram/start \
  -H 'content-type: application/json' \
  --data-binary '{"phone":"+65XXXXXXXX","deviceTimezone":"Asia/Singapore"}'
```

Telegram sends a code to your app. Then:

```sh
curl -s -X POST localhost:3000/v1/auth/telegram/verify \
  -H 'content-type: application/json' \
  --data-binary '{"attemptId":"<from above>","code":"12345"}'
```

If you have 2FA on you get `409 password_required`; repeat with `"password":"..."` added.

- [ ] The response contains **no** session string.
- [ ] `select encrypted_session from telegram_connections;` is unreadable bytes.
- [ ] Save the returned `sessionToken` as `$TOKEN` for the rest of this checklist.

## 3. Folders — the highest-risk area

```sh
curl -s localhost:3000/v1/folders -H "authorization: Bearer $TOKEN"
```

- [ ] Your **real** folder names appear, matching the Telegram app exactly.
- [ ] A folder built from category flags (e.g. "all channels") appears, not just
      hand-picked ones.

`GramJsTelegramPort.resolveFolderChats` reimplements Telegram's filter semantics — pinned and
included peers, excluded peers, and the `contacts` / `nonContacts` / `groups` / `broadcasts` /
`bots` category flags. **This is the code most likely to be subtly wrong**, because the fake
cannot model it.

## 4. Select a folder and sync

```sh
curl -s -X PUT localhost:3000/v1/folder-selection -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data-binary '{"telegramFolderId":2,"folderTitle":"Opportunities","lookbackDays":7}'
```

Then start the worker (terminal 3):

```sh
pnpm --filter @easycal/worker dev
```

- [ ] It logs `sync run finished` with a non-zero `messagesIngested`.
- [ ] `select title, is_currently_in_folder from source_chats;` lists the chats you expect.
- [ ] **A muted channel is included** — that is the whole product premise.
- [ ] `select count(*) from raw_messages;` is non-zero and messages are only from the
      lookback window.
- [ ] Run it twice: the second run ingests ~0 new messages (cursors work against real ids).

## 5. Events

```sh
curl -s "localhost:3000/v1/events" -H "authorization: Bearer $TOKEN"
```

- [ ] At least one real event was extracted.
- [ ] Its date and time are correct in **your** timezone, not shifted by the UTC offset.
- [ ] An RSVP link posted as a Telegram link entity ("sign up here") is captured as a URL —
      this exercises `extractLinkEntities`, which the fake supplies pre-built.

Remember the parser is still `StubEventParser`. Poor extraction quality here is expected and is
Person B's work; what you are checking is that **text, entities and timestamps arrive intact**.

## 6. ICS

```sh
curl -s "localhost:3000/v1/events.ics" -H "authorization: Bearer $TOKEN" -o easycal.ics
open easycal.ics   # imports into Calendar.app
```

- [ ] It imports without error and the times match the API response.

## 7. Share and revoke

```sh
curl -s -X POST localhost:3000/v1/share-snapshots -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data-binary '{"title":"This week","eventIds":["<id>"]}'

curl -s localhost:3000/s/<token>          # public, no auth
curl -s -D- -o /dev/null localhost:3000/s/<token> | grep -i x-robots-tag
```

- [ ] The public payload contains **no** message text, chat id, message id or `@handle`.
- [ ] `x-robots-tag: noindex` is present.
- [ ] After `DELETE /v1/share-snapshots/<id>`, the public URL returns 404.

## 8. Failure handling

Hard to trigger deliberately; check opportunistically:

- [ ] Log out of this session from Telegram's own "Devices" screen, then run a sync. The
      connection should flip to `reauth_required` rather than failing silently:
      `select status from telegram_connections;`
- [ ] If you hit a `FLOOD_WAIT`, the worker logs `rate limited by Telegram; backing off`
      and waits the stated number of seconds instead of hammering.

## Known limitations to confirm, not fix

- One API instance only: in-progress logins are held in memory.
- `GET /v1/folders` reads a cache, so a folder created after your last login/sync appears only
  after the next sync run.
