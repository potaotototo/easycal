-- Person A additions on top of the reference schema:
--   1. The Telegram account is the app identity, so a returning user must be
--      identifiable by their Telegram user id, and app sessions need somewhere to live.
--   2. docs/architecture.md requires a sync cursor per chat; schema.sql had nowhere
--      to record per-chat progress.
-- These do not change packages/contracts/src/event.ts.

-- Up Migration

alter table users add column telegram_user_id text not null;
alter table users add constraint users_telegram_user_id_key unique (telegram_user_id);
alter table users alter column device_timezone set default 'UTC';

create table user_sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index user_sessions_user_id_idx on user_sessions (user_id);

create table sync_cursors (
  connection_id uuid not null references telegram_connections(id) on delete cascade,
  source_chat_id uuid not null references source_chats(id) on delete cascade,
  last_message_id text,
  last_synced_at timestamptz,
  primary key (connection_id, source_chat_id)
);

-- Query paths the API and worker rely on.
create index raw_messages_chat_sent_at_idx on raw_messages (source_chat_id, sent_at desc);
create index calendar_events_user_date_idx on calendar_events (user_id, event_date);
create index event_candidates_user_status_idx on event_candidates (user_id, status);
create index source_chats_connection_in_folder_idx
  on source_chats (connection_id) where is_currently_in_folder;

-- Down Migration

drop index source_chats_connection_in_folder_idx;
drop index event_candidates_user_status_idx;
drop index calendar_events_user_date_idx;
drop index raw_messages_chat_sent_at_idx;
drop table sync_cursors;
drop index user_sessions_user_id_idx;
drop table user_sessions;
alter table users alter column device_timezone drop default;
alter table users drop constraint users_telegram_user_id_key;
alter table users drop column telegram_user_id;
