# Event Preferences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Categorize extracted events in the backend and hard-filter calendar and ICS results using editable user interest and location preferences, with the same behavior in the frontend demo.

**Architecture:** A shared fixed category contract feeds a worker-side classifier that uses validated structured LLM output with deterministic fallback. PostgreSQL stores event categories and one preference row per user; repository-level filtering keeps JSON and ICS output consistent. The web app edits preferences through authenticated endpoints and mirrors the behavior in demo state.

**Tech Stack:** TypeScript, Node.js 22, Fastify 5, Zod 3, PostgreSQL, Vitest, React 19, Vinext/Sites.

**Spec:** `docs/superpowers/specs/2026-09-02-event-preferences-design.md`

## Global Constraints

- The fixed v1 taxonomy is `career`, `internships`, `technology`, `entrepreneurship`, `education`, `networking`, `community`, `volunteering`, `sports_wellness`, `arts_culture`, `social`, and `other`.
- Default interests are `career`, `internships`, `technology`, `entrepreneurship`, `networking`, and `community`.
- Empty location terms mean unrestricted location; configured terms hard-hide non-matching or locationless events.
- Model output is untrusted and must be reduced to the fixed taxonomy; classification failure falls back and never fails a sync by itself.
- Raw Telegram content, model prompts, credentials, and user preferences must not be logged or exposed in public snapshots.
- Map APIs, radius search, arbitrary custom interests, semantic ranking, and notification settings are out of scope.
- User-facing branding remains lowercase `easycal`, and review actions remain `Remove`, `Edit`, `Accept`.

---

### Task 1: Shared category contract and classifier

**Files:**
- Modify: `packages/contracts/src/event.ts`
- Create: `apps/worker/src/classification/categories.ts`
- Create: `apps/worker/src/classification/classifier.ts`
- Create: `apps/worker/src/classification/classifier.test.ts`
- Modify: `apps/worker/src/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `EVENT_CATEGORIES`, `EventCategory`, and `categories: EventCategory[]` on `EventCandidate` and `CalendarEvent`.
- Produces: `EventCategoryClassifier.classify(input): Promise<EventCategory[]>`, `DeterministicEventCategoryClassifier`, and `OpenAIEventCategoryClassifier`.

- [ ] **Step 1: Add failing classifier tests**

Test that deterministic classification maps NOC/startup copy to `entrepreneurship`, career-fair copy to `career`, and unknown copy to `other`. Test that structured output drops unsupported and duplicate values and falls back to deterministic output when the model response or request fails.

```ts
expect(await classifier.classify({ title: "NOC alumni sharing", description: null, locationName: "NUS Enterprise", sourceLabel: null, evidenceText: "startup immersion" }))
  .toContain("entrepreneurship");
expect(validateCategories(["career", "career", "made_up"])).toEqual(["career"]);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run apps/worker/src/classification/classifier.test.ts`

Expected: failure because the classification modules and category contract do not exist.

- [ ] **Step 3: Add the taxonomy and classifier implementations**

Export the category tuple and guard from contracts. Implement deterministic regex groups and an OpenAI-compatible Responses API request using server-only `OPENAI_API_KEY` and `OPENAI_CATEGORY_MODEL`. Request strict JSON matching `{ categories: EventCategory[] }`, validate locally, and fall back on any failure.

```ts
export const EVENT_CATEGORIES = ["career", "internships", "technology", "entrepreneurship", "education", "networking", "community", "volunteering", "sports_wellness", "arts_culture", "social", "other"] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run apps/worker/src/classification/classifier.test.ts && pnpm --filter @easycal/contracts typecheck && pnpm --filter @easycal/worker typecheck`

Expected: all commands pass.

- [ ] **Step 5: Commit the contract and classifier**

```bash
git add packages/contracts/src/event.ts apps/worker/src/classification apps/worker/src/env.ts .env.example
git commit -m "Add validated event category classification"
```

### Task 2: Preference and category persistence

**Files:**
- Create: `db/migrations/1788350000000_event_preferences.sql`
- Modify: `db/schema.sql`
- Create: `db/src/repositories/preferences.ts`
- Create: `db/src/repositories/preferences.test.ts`
- Modify: `db/src/repositories/events.ts`
- Modify: `db/src/repositories/users.ts`
- Modify: `db/src/index.ts`

**Interfaces:**
- Produces: `UserPreferences`, `DEFAULT_INTEREST_CATEGORIES`, `getOrCreatePreferences(db, userId)`, and `savePreferences(db, userId, input)`.
- Extends: `CalendarEventInput.categories` and event row mapping.

- [ ] **Step 1: Add failing repository tests**

Cover default creation, idempotent reads, replacement updates, case-insensitive location deduplication, invalid category rejection, and persistence of categories on promoted events.

```ts
expect(await getOrCreatePreferences(db, userId)).toEqual({
  interestCategories: ["career", "internships", "technology", "entrepreneurship", "networking", "community"],
  locationTerms: [],
});
```

- [ ] **Step 2: Run repository tests and verify RED**

Run: `pnpm vitest run db/src/repositories/preferences.test.ts`

Expected: failure because the migration and repository are absent.

- [ ] **Step 3: Implement schema, migration, and repositories**

Add `calendar_events.categories text[] not null default array['other']::text[]` and `user_preferences(user_id primary key, interest_categories text[] not null, location_terms text[] not null default '{}', updated_at timestamptz not null default now())`. Backfill preferences for existing users. Validate arrays before writes and export the repository.

- [ ] **Step 4: Run migrations, tests, and typecheck**

Run: `pnpm vitest run db/src/repositories/preferences.test.ts && pnpm --filter @easycal/db typecheck`

Expected: tests and typecheck pass against the temporary test database.

- [ ] **Step 5: Commit persistence**

```bash
git add db/schema.sql db/migrations/1788350000000_event_preferences.sql db/src
git commit -m "Persist event categories and user preferences"
```

### Task 3: Worker enrichment and filtered event queries

**Files:**
- Modify: `apps/worker/src/sync/engine.ts`
- Modify: `apps/worker/src/sync/engine.test.ts`
- Modify: `apps/worker/src/sync/acceptance.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `db/src/repositories/events.ts`
- Modify: `apps/api/src/routes/api.test.ts`

**Interfaces:**
- `SyncDeps` consumes `classifier: EventCategoryClassifier`.
- `listEvents` loads the current preferences and applies category overlap plus optional venue/address matching.

- [ ] **Step 1: Add failing sync and query tests**

Assert the classifier runs before `saveCandidate`, categories reach `upsertCalendarEvent`, categories are OR-matched, and a configured location is AND-matched. Assert empty locations allow any venue after category matching.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run apps/worker/src/sync/engine.test.ts apps/api/src/routes/api.test.ts`

Expected: failures showing categories are neither enriched nor filtered.

- [ ] **Step 3: Enrich candidates and centralize filtering**

Create the classifier in the worker entrypoint, pass it through `SyncDeps`, and replace each candidate with `{ ...candidate, categories }` before saving and promotion. In `listEvents`, join `user_preferences`, require `e.categories && p.interest_categories`, and add the location predicate only when `cardinality(p.location_terms) > 0`.

- [ ] **Step 4: Run worker/API tests and typecheck**

Run: `pnpm vitest run apps/worker/src/sync/engine.test.ts apps/worker/src/sync/acceptance.test.ts apps/api/src/routes/api.test.ts && pnpm --filter @easycal/worker typecheck && pnpm --filter @easycal/api typecheck`

Expected: all pass.

- [ ] **Step 5: Commit worker and query integration**

```bash
git add apps/worker db/src/repositories/events.ts apps/api/src/routes/api.test.ts
git commit -m "Filter synced events by classified preferences"
```

### Task 4: Authenticated preferences API

**Files:**
- Create: `apps/api/src/routes/preferences.ts`
- Create: `apps/api/src/routes/preferences.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Produces: `GET /v1/preferences` and `PUT /v1/preferences` with `{ interestCategories: EventCategory[]; locationTerms: string[] }`.

- [ ] **Step 1: Add failing route tests**

Test authentication, defaults, successful replacement, unsupported category rejection, empty interests rejection, normalization, and unchanged data after a rejected request.

```ts
const response = await app.inject({ method: "PUT", url: "/v1/preferences", headers: auth, payload: { interestCategories: ["career"], locationTerms: [" NUS ", "nus"] } });
expect(response.json()).toEqual({ interestCategories: ["career"], locationTerms: ["NUS"] });
```

- [ ] **Step 2: Run route tests and verify RED**

Run: `pnpm vitest run apps/api/src/routes/preferences.test.ts`

Expected: 404 responses because routes are not registered.

- [ ] **Step 3: Implement and register routes**

Use Zod enums derived from the fixed category tuple, require one interest and at most 20 location terms of 1–80 characters, and call the repository only after successful parsing.

- [ ] **Step 4: Run API tests and typecheck**

Run: `pnpm vitest run apps/api/src/routes/preferences.test.ts apps/api/src/routes/api.test.ts && pnpm --filter @easycal/api typecheck`

Expected: all pass.

- [ ] **Step 5: Commit the API**

```bash
git add apps/api/src/routes/preferences.ts apps/api/src/routes/preferences.test.ts apps/api/src/server.ts
git commit -m "Expose user event preferences API"
```

### Task 5: Frontend preferences and categorized demo

**Files:**
- Create: `apps/web/app/lib/preferences.ts`
- Create: `apps/web/app/lib/preferences.test.ts`
- Modify: `apps/web/app/lib/events-api.ts`
- Modify: `apps/web/app/lib/demo-events.ts`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Produces: `UserPreferencesView`, `fetchPreferences()`, `savePreferences(input)`, and `eventMatchesPreferences(event, preferences)`.
- Extends: `CalendarEventView.categories`.

- [ ] **Step 1: Add failing frontend logic tests**

Test category overlap, location restriction, empty location behavior, and verify every demo event has at least one valid category.

```ts
assert.equal(eventMatchesPreferences(event, { interestCategories: ["technology"], locationTerms: ["NUS"] }), true);
assert.ok(demoEvents.every((event) => event.categories.length > 0));
```

- [ ] **Step 2: Run frontend tests and verify RED**

Run: `pnpm --filter @easycal/web test`

Expected: failure because preference helpers and event categories are missing.

- [ ] **Step 3: Implement API adapter and demo filtering**

Add preference GET/PUT functions, categories to normalization and every fake event, and pure hard-filtering helpers. Align event mutations with the backend: remove uses `{ action: "dismiss" }`, edit uses `{ action: "correct", ...fields }`, and accept is a local review transition unless/until the backend exposes confirmation of unconfirmed candidates.

- [ ] **Step 4: Implement the settings panel**

Add a Preferences button, fixed selectable chips, removable location chips/input, save/cancel/error states, and a no-match empty state. In API mode load preferences on mount and reload events after save; in demo mode keep preferences in React session state.

- [ ] **Step 5: Style and verify frontend**

Run: `pnpm --filter @easycal/web test && pnpm --filter @easycal/web lint && pnpm --filter @easycal/web check && pnpm --filter @easycal/web build`

Expected: tests, lint, typecheck, and production build pass.

- [ ] **Step 6: Commit frontend integration**

```bash
git add apps/web/app apps/web/public/og.png
git commit -m "Add category and location preferences UI"
```

### Task 6: Full verification and Sites preview

**Files:**
- Modify if needed: `README.md`
- Modify if needed: `apps/api/README.md`
- Modify if needed: `apps/worker/README.md`
- Modify if needed: `apps/web/.openai/hosting.json`

**Interfaces:**
- Consumes the complete feature; produces verification evidence and a saved Sites version.

- [ ] **Step 1: Run the full workspace suite**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: all packages pass with no category or preference regressions.

- [ ] **Step 2: Run the frontend quality suite**

Run: `pnpm --filter @easycal/web test && pnpm --filter @easycal/web lint && pnpm --filter @easycal/web build`

Expected: all pass.

- [ ] **Step 3: Exercise the demo in a browser**

Verify default matching events render, deselecting categories hard-hides events only after a valid save, adding `NUS` hides non-NUS events, clearing locations restores category matches, every fake event can display categories, and the `Remove`, `Edit`, `Accept` flow remains usable on desktop and mobile widths.

- [ ] **Step 4: Save a private Sites version**

Package the verified web output using the existing Sites project metadata and save a new version. Do not deploy publicly without explicit approval if the project access is public or shared.

- [ ] **Step 5: Commit documentation changes if any**

```bash
git add README.md apps/api/README.md apps/worker/README.md
git commit -m "Document event preference configuration"
```
