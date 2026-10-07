// P1-SCHED-013: the model's reading of a date is cross-checked against the client's own words, read by rules, inside decideScheduling. A disagreement records the
// request WITHOUT a time for a person to confirm, so a wrong guess never becomes a booking window; no opinion leaves the model's reading alone.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { modelDateAgrees } from '../src/lib/scheduling/p1o-policy.ts';
import { decideScheduling } from '../src/modules/crm/scheduling-request.ts';

const now = new Date('2026-12-02T06:30:00Z'); // Wednesday noon in Kolkata

describe('the cross-check on its own', () => {
  test('words and reading name the same local day: agree', () => {
    assert.equal(modelDateAgrees('can we talk tomorrow at 4', new Date('2026-12-03T10:30:00Z'), now, 'Asia/Kolkata'), 'agree');
  });
  test('words name tomorrow, the reading chose another day: disagrees', () => {
    assert.equal(modelDateAgrees('can we talk tomorrow at 4', new Date('2026-12-05T10:30:00Z'), now, 'Asia/Kolkata'), 'disagrees');
  });
  test('a weekday is checked too', () => {
    assert.equal(modelDateAgrees('friday evening', new Date('2026-12-04T12:00:00Z'), now, 'Asia/Kolkata'), 'agree');
    assert.equal(modelDateAgrees('friday evening', new Date('2026-12-11T12:00:00Z'), now, 'Asia/Kolkata'), 'disagrees');
  });
  test('words with no relative day or weekday give no opinion: the model alone may read "the 14th"', () => {
    assert.equal(modelDateAgrees('on the 14th at 4', new Date('2026-12-14T10:30:00Z'), now, 'Asia/Kolkata'), 'no_opinion');
    assert.equal(modelDateAgrees('2026-12-14 works', new Date('2026-12-15T10:30:00Z'), now, 'Asia/Kolkata'), 'no_opinion');
  });
  test('an unreadable zone gives no opinion rather than a wrong one', () => {
    assert.equal(modelDateAgrees('tomorrow', new Date('2026-12-03T10:30:00Z'), now, 'Mars/Olympus'), 'no_opinion');
  });
});

const reading = (startAt: string, evidence: string) => ({ intent: 'call' as const, explicit: true, mode: 'call' as const, startAt, windowEnd: null, evidence }) as never;

describe('inside decideScheduling', () => {
  test('an agreeing time is kept', () => {
    const d = decideScheduling(reading('2026-12-03T16:00:00+05:30', 'call me tomorrow at 4pm'), now, 'Asia/Kolkata');
    assert.ok(d.act === 'request' && d.startAt !== null && d.dropped === null);
  });
  test('a disagreeing time is dropped, the request stands, and the reason is named', () => {
    const d = decideScheduling(reading('2026-12-05T16:00:00+05:30', 'call me tomorrow at 4pm'), now, 'Asia/Kolkata');
    assert.ok(d.act === 'request' && d.startAt === null && d.windowEnd === null && d.dropped === 'date_disagrees');
  });
  test('words that name no relative day leave the model alone', () => {
    const d = decideScheduling(reading('2026-12-14T16:00:00+05:30', 'call me on the 14th at 4pm'), now, 'Asia/Kolkata');
    assert.ok(d.act === 'request' && d.startAt !== null && d.dropped === null);
  });
});
