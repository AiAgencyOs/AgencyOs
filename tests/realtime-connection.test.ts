import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEGRADED_AFTER_FAILURES,
  describeStatus,
  initialLiveState,
  pollIntervalMs,
  reduceLive,
  type LiveEvent,
  type LiveState,
} from '../src/lib/realtime/connection.ts';

function run(events: LiveEvent[], from: LiveState = initialLiveState()): LiveState {
  return events.reduce(reduceLive, from);
}

/**
 * The live indicator's three promises — LIVE is earned, a rejoin catches up,
 * and repeated failure degrades to polling rather than dying — as a state
 * machine a test can walk without a socket.
 */
describe('a screen never claims LIVE on its own say-so', () => {
  it('starts connecting, not live', () => {
    assert.equal(initialLiveState().status, 'connecting');
  });

  it('is live only after the channel said SUBSCRIBED', () => {
    assert.equal(run([{ type: 'subscribed' }]).status, 'live');
  });

  it('an event alone does not make it live', () => {
    assert.equal(run([{ type: 'event' }]).status, 'connecting');
  });
});

describe('a reconnect is a catch-up', () => {
  it('the first join is not a catch-up — the page just rendered', () => {
    assert.equal(run([{ type: 'subscribed' }]).catchUps, 0);
  });

  it('every rejoin after a drop counts one catch-up', () => {
    const s = run([{ type: 'subscribed' }, { type: 'closed' }, { type: 'subscribed' }, { type: 'error' }, { type: 'subscribed' }]);
    assert.equal(s.catchUps, 2);
    assert.equal(s.status, 'live');
    assert.equal(s.failures, 0);
  });
});

describe('repeated failure degrades rather than dies', () => {
  it('one drop is reconnecting', () => {
    assert.equal(run([{ type: 'subscribed' }, { type: 'closed' }]).status, 'reconnecting');
  });

  it(`${DEGRADED_AFTER_FAILURES} consecutive failures is degraded`, () => {
    const events: LiveEvent[] = Array.from({ length: DEGRADED_AFTER_FAILURES }, () => ({ type: 'error' as const }));
    assert.equal(run(events).status, 'degraded');
  });

  it('a subscribe after degradation is live again with failures reset', () => {
    const events: LiveEvent[] = [...Array.from({ length: DEGRADED_AFTER_FAILURES }, () => ({ type: 'error' as const })), { type: 'subscribed' }];
    const s = run(events);
    assert.equal(s.status, 'live');
    assert.equal(s.failures, 0);
  });

  it('a page with no transport is polling, and a stray close does not un-poll it', () => {
    assert.equal(run([{ type: 'unsupported' }, { type: 'closed' }]).status, 'polling');
  });
});

describe('the safety net polls at the rate the status deserves', () => {
  it('live keeps a slow net; everything else polls at the old AutoRefresh rate or faster', () => {
    assert.equal(pollIntervalMs('live'), 120_000);
    assert.ok(pollIntervalMs('reconnecting') <= 30_000);
    assert.equal(pollIntervalMs('degraded'), 30_000);
    assert.equal(pollIntervalMs('polling'), 30_000);
  });

  it('every status has words, not just a colour', () => {
    for (const status of ['connecting', 'live', 'reconnecting', 'degraded', 'polling'] as const) {
      const d = describeStatus(status);
      assert.ok(d.label.length > 0 && d.detail.length > 0, status);
    }
    assert.equal(describeStatus('live').tone, 'success');
    assert.equal(describeStatus('degraded').tone, 'danger');
  });
});
