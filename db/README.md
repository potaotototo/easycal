# Database

`db/schema.sql` is the human-readable reference model. `db/migrations/` holds the executable
migrations; every schema change lands in **both** so they never drift.

## Local Postgres — no Docker required

`embedded-postgres` unpacks a real Postgres 17 server into `node_modules` and runs it as a child
process. Nothing is installed system-wide and no daemon is involved.

```sh
pnpm db          # start Postgres in the foreground (Ctrl-C to stop)
pnpm migrate     # in another terminal, apply migrations
```

The cluster is shut down when the `pnpm db` process exits, which is why it runs in the
foreground. Data persists in `db/.pgdata` (gitignored) between runs; `pnpm db:reset` wipes it and
initialises a fresh cluster.

Connection string, matching `.env.example`:

```
postgres://easycal:easycal@localhost:5432/easycal
```

Override the port with `PGPORT` if 5432 is taken.

### Docker alternative

`infra/docker-compose.yml` runs the same Postgres 17 if you would rather use containers, and is
where the api/worker services will be defined for deployment:

```sh
pnpm db:docker        # up
pnpm db:docker:down   # down
```

## Migrations

```sh
pnpm migrate                  # apply everything pending
pnpm migrate:down             # roll back one step
pnpm --filter @easycal/db migrate:create my_change
```

Files are timestamp-prefixed (`node-pg-migrate` warns on any other naming) and each contains an
`-- Up Migration` and a `-- Down Migration` section. Down migrations are expected to work: the
current pair takes the schema from 14 tables to 1 and back.

## TypeScript exports

`@easycal/db` exports the shared connection pool used by **both** `apps/api` and `apps/worker`, so
connection limits stay observable in one place:

```ts
import { getPool, withTransaction, closePool } from "@easycal/db";
```

Callers must not construct their own `pg.Pool`.
