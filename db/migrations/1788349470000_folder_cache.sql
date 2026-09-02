-- The API is never given a key that can decrypt a stored Telegram session
-- (docs/architecture.md), so it cannot list folders on demand. Folders are cached
-- instead: written by the API from the live client it still holds right after
-- login, and refreshed by the worker on every sync run.

-- Up Migration

create table telegram_folders (
  connection_id uuid not null references telegram_connections(id) on delete cascade,
  telegram_folder_id integer not null,
  title text not null,
  refreshed_at timestamptz not null default now(),
  primary key (connection_id, telegram_folder_id)
);

-- Down Migration

drop table telegram_folders;
