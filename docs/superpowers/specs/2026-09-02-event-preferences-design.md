# Event preference filtering design

## Goal

easycal should prevent Telegram noise from being recreated in the calendar. Every extracted event receives one or more normalized categories, and private calendar reads expose only events that match the signed-in user's selected categories and optional preferred locations.

New users receive useful default interests. They can edit those interests and locations later from the calendar. The demo experience uses the same category and filtering semantics without requiring a backend.

## Scope

Version 1 supports a fixed category taxonomy:

- `career`
- `internships`
- `technology`
- `entrepreneurship`
- `education`
- `networking`
- `community`
- `volunteering`
- `sports_wellness`
- `arts_culture`
- `social`
- `other`

The default interests are `career`, `internships`, `technology`, `entrepreneurship`, `networking`, and `community`. Preferred locations start empty, meaning any location is permitted after the category requirement passes.

Custom interest text, map/geocoding integration, radius searches, semantic ranking, and per-event notification preferences are out of scope. Locations are case-insensitive text terms matched against the parsed venue and address.

## Shared contract

`packages/contracts` defines `EventCategory` as the fixed enum and adds `categories: EventCategory[]` to both `EventCandidate` and `CalendarEvent`. A candidate must always contain at least one category. Unclassifiable events use `other`.

The existing parser output remains responsible for event facts. Categorization is a separate worker-side enrichment step so it runs for events produced by either deterministic extraction or the structured-model fallback.

## Category classification

The worker introduces a small `EventCategoryClassifier` interface. Its production implementation sends the minimum useful event content to a configured backend LLM: title, authored description when available, venue, source label, and the normalized evidence text needed to classify the announcement. The requested output is a JSON object containing only `categories` from the fixed taxonomy.

The worker validates all model output locally, removes duplicates, and converts empty, malformed, or unsupported output to `other`. A deterministic classifier is retained for tests, local development, and deployments without model credentials. It maps explicit signals such as career fairs, internships, NOC, startups, workshops, networking, volunteering, sports, arts, and social events to the same enum. Classification failure must not stop message synchronization.

The model provider is isolated behind the classifier interface. Configuration uses environment variables and never exposes credentials to the browser.

## Persistence

A migration adds:

- `calendar_events.categories text[] not null default array['other']`
- `user_preferences`, keyed one-to-one by `user_id`, with `interest_categories text[]`, `location_terms text[]`, and `updated_at`

The reference schema and executable migrations remain synchronized. Repository validation prevents unsupported categories from being written even if a caller bypasses the HTTP layer.

When a user is created, default preferences are created transactionally or lazily through an idempotent repository helper. Existing users receive the same defaults through migration backfill. Existing calendar events receive `other` until a later sync reclassifies them.

Categories are copied from a confirmed candidate into `calendar_events` during promotion and updated when the same candidate is reprocessed.

## Filtering semantics

Private event queries require at least one overlap between `calendar_events.categories` and `user_preferences.interest_categories`.

Within interests, matching is OR. Within locations, matching is OR. Between the two groups, matching is AND. When `location_terms` is empty, location is unrestricted. When locations are configured, events with no matching venue or address are hidden.

The repository applies this filter centrally so `GET /v1/events` and `GET /v1/events.ics` behave consistently. `GET /v1/events/:id` remains user-scoped and may return a known event directly; preferences are relevance rules rather than authorization rules. Immutable public snapshots do not change after creation.

## Preferences API

Authenticated endpoints are added:

- `GET /v1/preferences` returns `{ interestCategories, locationTerms }`, creating defaults when needed.
- `PUT /v1/preferences` replaces both arrays after validation and returns the saved preferences.

At least one interest category is required so an accidental empty selection cannot silently produce an unusable calendar. Location terms are trimmed, case-insensitively deduplicated, length-limited, and may be empty. Unsupported categories and malformed bodies return HTTP 400 without changing stored preferences.

## Frontend

The private calendar gains a Preferences control that opens an accessible settings panel. The panel presents the fixed interests as selectable chips and locations as removable text chips with an input for adding areas such as `NUS`, `Kent Ridge`, or `online`.

Saving calls `PUT /v1/preferences`, closes only after success, and reloads the visible month. Network or validation failures remain visible in the panel without discarding edits. A short empty-calendar message explains when no events match the current preferences and links back to the settings panel.

Demo mode starts with the same default preferences, assigns categories to every seeded fake event, and filters entirely in browser state. Demo preference edits last for the current page session; they do not pretend to persist remotely.

The API adapter is aligned with the newly integrated backend while this surface is connected: dismiss sends `{ action: "dismiss" }`, accept/edit behavior follows the backend contract, and correction fields use the backend's accepted shape.

## Data flow

1. Telegram messages are parsed into event candidates.
2. The worker classifier assigns validated categories.
3. Candidate payload and promoted calendar event persist those categories.
4. The API loads or initializes the authenticated user's preferences.
5. Calendar and ICS queries filter category overlap and optional location matches in PostgreSQL.
6. The frontend edits preferences through the API and reloads events after a successful save.

## Error handling and privacy

Model timeouts, invalid structured output, or missing credentials fall back to deterministic classification and never fail the sync run solely because categorization failed. Database and HTTP validation use the same category set.

Only authenticated users can read or change preferences. Model credentials stay server-side. Logs must not contain raw Telegram text or model prompts. Public snapshots continue to omit raw evidence and user preferences.

## Testing

Backend tests cover:

- model output validation and deterministic fallback;
- category persistence during candidate promotion;
- default preference creation and update validation;
- OR-within/AND-between filtering, including unrestricted and configured locations;
- consistent filtering for JSON event lists and ICS exports;
- authenticated preference route behavior.

Frontend checks cover:

- loading, editing, saving, and error states;
- hard filtering in demo mode;
- categories on all seeded fake events;
- the no-match empty state;
- the corrected event mutation request shapes.

Workspace tests, lint, production build, and an interactive browser pass verify the integrated flow before completion.
