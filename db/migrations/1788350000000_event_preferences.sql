-- Adds normalized event categories and per-user relevance preferences.

-- Up Migration

alter table calendar_events
  add column categories text[] not null default array['other']::text[],
  add constraint calendar_event_categories_not_empty check (cardinality(categories) > 0),
  add constraint calendar_event_categories_valid check (
    categories <@ array[
      'career', 'internships', 'technology', 'entrepreneurship', 'education',
      'networking', 'community', 'volunteering', 'sports_wellness',
      'arts_culture', 'social', 'other'
    ]::text[]
  );

create table user_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  interest_categories text[] not null,
  location_terms text[] not null default '{}'::text[],
  updated_at timestamptz not null default now(),
  check (cardinality(interest_categories) > 0),
  check (interest_categories <@ array[
    'career', 'internships', 'technology', 'entrepreneurship', 'education',
    'networking', 'community', 'volunteering', 'sports_wellness',
    'arts_culture', 'social', 'other'
  ]::text[])
);

insert into user_preferences (user_id, interest_categories)
select id, array['career', 'internships', 'technology', 'entrepreneurship', 'networking', 'community']::text[]
from users
on conflict (user_id) do nothing;

-- Down Migration

drop table user_preferences;
alter table calendar_events drop constraint calendar_event_categories_valid;
alter table calendar_events drop constraint calendar_event_categories_not_empty;
alter table calendar_events drop column categories;
