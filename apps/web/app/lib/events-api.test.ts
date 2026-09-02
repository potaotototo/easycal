import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePublicSnapshot } from './events-api.ts';

test('public snapshots allow-list fields and discard source text and evidence', () => {
  const snapshot = normalizePublicSnapshot({
    title: 'Shared events',
    events: [{
      id: 'event-1',
      title: 'Public title',
      description: 'Private Telegram source text @private_handle',
      eventDate: '2026-09-02',
      allDay: true,
      status: 'confirmed',
      evidence: [{ telegramChatId: 'secret-chat', normalizedText: 'secret' }],
    }],
  });

  assert.equal(snapshot.events[0]?.description, null);
  assert.equal(Object.hasOwn(snapshot.events[0]!, 'status'), false);
  assert.equal(Object.hasOwn(snapshot.events[0]!, 'evidence'), false);
});
