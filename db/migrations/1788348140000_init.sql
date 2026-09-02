-- Faithful transcription of db/schema.sql at the time this migration was written.
-- db/schema.sql remains the human-readable reference model; keep the two in sync.

-- Up Migration

create table users (
  id uuid primary key,
  created_at timestamptz not null default now(),
  device_timezone text not null
);

create table telegram_connections (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  encrypted_session bytea not null,
  status text not null check (status in ('active', 'reauth_required', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table folder_selections (
  id uuid primary key,
  connection_id uuid not null unique references telegram_connections(id) on delete cascade,
  telegram_folder_id integer not null,
  folder_title text not null,
  lookback_days integer not null default 7 check (lookback_days between 1 and 90),
  updated_at timestamptz not null default now()
);

create table source_chats (
  id uuid primary key,
  connection_id uuid not null references telegram_connections(id) on delete cascade,
  telegram_chat_id text not null,
  title text not null,
  username text,
  is_currently_in_folder boolean not null default true,
  unique (connection_id, telegram_chat_id)
);

create table sync_runs (
  id uuid primary key,
  connection_id uuid not null references telegram_connections(id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text
);

create table raw_messages (
  id uuid primary key,
  connection_id uuid not null references telegram_connections(id) on delete cascade,
  source_chat_id uuid not null references source_chats(id) on delete cascade,
  telegram_message_id text not null,
  sent_at timestamptz not null,
  raw_text text not null,
  normalized_text text not null,
  entities jsonb not null default '[]'::jsonb,
  reply_to_message_id text,
  content_hash text not null,
  ingested_at timestamptz not null default now(),
  unique (connection_id, source_chat_id, telegram_message_id)
);

create table event_candidates (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  status text not null check (status in ('confirmed', 'unconfirmed', 'dismissed')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  payload jsonb not null,
  review_reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table calendar_events (
  id uuid primary key,
  candidate_id uuid not null unique references event_candidates(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  description text,
  event_date date not null,
  start_at timestamptz,
  end_at timestamptz,
  timezone text,
  all_day boolean not null,
  location_name text,
  address text,
  rsvp_url text,
  directions_channel text,
  source_label text,
  created_at timestamptz not null default now(),
  check ((all_day and start_at is null and end_at is null) or (not all_day and start_at is not null))
);

create table event_evidence (
  event_candidate_id uuid not null references event_candidates(id) on delete cascade,
  raw_message_id uuid not null references raw_messages(id) on delete cascade,
  primary key (event_candidate_id, raw_message_id)
);

create table share_snapshots (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  title text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table share_snapshot_events (
  snapshot_id uuid not null references share_snapshots(id) on delete cascade,
  event_id uuid not null references calendar_events(id) on delete restrict,
  public_payload jsonb not null,
  position integer not null,
  primary key (snapshot_id, event_id)
);

-- Down Migration

drop table share_snapshot_events;
drop table share_snapshots;
drop table event_evidence;
drop table calendar_events;
drop table event_candidates;
drop table raw_messages;
drop table sync_runs;
drop table source_chats;
drop table folder_selections;
drop table telegram_connections;
drop table users;
