import assert from 'node:assert/strict';
import test from 'node:test';
import { correctEvent, updateEventStatus } from './events-api.ts';

const event = {
  id: 'evt-1',
  title: 'AI workshop',
  description: null,
  startAt: null,
  endAt: null,
  eventDate: '2026-09-03',
  timezone: 'Asia/Singapore',
  allDay: true,
  locationName: 'NUS',
  address: null,
  rsvpUrl: null,
  sourceLabel: 'Tech Club',
  categories: ['technology'],
};

test('event mutations use the backend action contract and unwrap its event envelope', async () => {
  const requests: RequestInit[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    requests.push(init ?? {});
    return new Response(JSON.stringify({ event }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await updateEventStatus(event.id, 'confirmed');
    const corrected = await correctEvent(event.id, {
      title: event.title,
      eventDate: event.eventDate,
      startAt: null,
      endAt: null,
      allDay: true,
      locationName: event.locationName,
      address: null,
      rsvpUrl: null,
    });
    assert.equal(JSON.parse(String(requests[0]!.body)).action, 'confirm');
    assert.equal(JSON.parse(String(requests[1]!.body)).action, 'correct');
    assert.equal(corrected.id, event.id);
    assert.deepEqual(corrected.categories, ['technology']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
