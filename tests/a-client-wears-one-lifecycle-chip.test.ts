import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CLIENT_LIFECYCLE_LABEL, clientLifecycle } from '../src/lib/admin/client-lifecycle.ts';

/** Q-CHIPS (owner, round 3): chips come from the client's projects; no overlap. */

describe('the four chips', () => {
  test('Active: at least one running project', () => {
    assert.equal(clientLifecycle({ active: 1 }), 'active');
    assert.equal(clientLifecycle({ active: 1, planning: 2, completed: 1 }), 'active');
  });

  test('Pending: only unstarted or signed projects', () => {
    assert.equal(clientLifecycle({ planning: 1 }), 'pending');
    assert.equal(clientLifecycle({ planning: 1, onboarding: 2 }), 'pending');
  });

  test('Completed: every project complete', () => {
    assert.equal(clientLifecycle({ completed: 3 }), 'completed');
  });

  test('On hold: a project on hold', () => {
    assert.equal(clientLifecycle({ on_hold: 1, completed: 4 }), 'on_hold');
  });

  test('the labels are the owner’s words', () => {
    assert.deepEqual(Object.values(CLIENT_LIFECYCLE_LABEL).sort(), ['Active', 'Completed', 'On hold', 'Pending']);
  });
});

describe('no overlap', () => {
  test('a client with a project on hold and one running wears On hold, not both', () => {
    assert.equal(clientLifecycle({ on_hold: 1, active: 1 }), 'on_hold');
  });

  test('every combination of project statuses yields at most one chip, and the chip obeys its rule', () => {
    const statuses = ['planning', 'onboarding', 'active', 'on_hold', 'completed', 'cancelled'] as const;
    const counts = [0, 1, 2];
    const walk = (i: number, acc: Record<string, number>) => {
      if (i === statuses.length) {
        const chip = clientLifecycle(acc);
        const live = Object.entries(acc).filter(([s]) => s !== 'cancelled').reduce((n, [, c]) => n + c, 0);
        if (chip === 'active') assert.ok((acc.active ?? 0) > 0 && !acc.on_hold, JSON.stringify(acc));
        if (chip === 'on_hold') assert.ok((acc.on_hold ?? 0) > 0, JSON.stringify(acc));
        if (chip === 'pending') assert.equal((acc.planning ?? 0) + (acc.onboarding ?? 0), live, JSON.stringify(acc));
        if (chip === 'completed') assert.equal(acc.completed ?? 0, live, JSON.stringify(acc));
        if (live === 0) assert.equal(chip, null, JSON.stringify(acc));
        return;
      }
      for (const c of counts) walk(i + 1, { ...acc, [statuses[i] as string]: c });
    };
    walk(0, {});
  });

  test('cancelled projects are not counted, and a client with none wears no chip', () => {
    assert.equal(clientLifecycle({ completed: 2, cancelled: 5 }), 'completed');
    assert.equal(clientLifecycle({ cancelled: 2 }), null);
    assert.equal(clientLifecycle({}), null);
    assert.equal(clientLifecycle(undefined), null);
  });

  test('a finished project beside an unstarted one fits no chip', () => {
    assert.equal(clientLifecycle({ completed: 1, planning: 1 }), null);
  });
});
