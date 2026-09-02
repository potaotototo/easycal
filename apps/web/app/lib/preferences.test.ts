import assert from 'node:assert/strict';
import test from 'node:test';
import { demoEvents } from './demo-events.ts';
import { DEFAULT_PREFERENCES, eventMatchesPreferences } from './preferences.ts';

test('matches categories before applying optional locations', () => {
  const event = demoEvents.find((item) => item.id === 'noc-sharing')!;
  assert.equal(eventMatchesPreferences(event, DEFAULT_PREFERENCES), true);
  assert.equal(eventMatchesPreferences(event, {
    interestCategories: ['sports_wellness'],
    locationTerms: [],
  }), false);
  assert.equal(eventMatchesPreferences(event, {
    interestCategories: ['entrepreneurship'],
    locationTerms: ['NUS'],
  }), true);
  assert.equal(eventMatchesPreferences(event, {
    interestCategories: ['entrepreneurship'],
    locationTerms: ['Jurong'],
  }), false);
});

test('every seeded demo event has at least one category', () => {
  assert.ok(demoEvents.every((event) => event.categories.length > 0));
});
