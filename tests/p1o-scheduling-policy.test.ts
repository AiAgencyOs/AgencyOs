// Phase 1 Scheduler: the policy as organisation settings, working hours, dayparts and the deterministic date reader (P1-SCHED-013/014/018/020/026).
// Pure. The working-hours rule here is the same one crm.p1o_within_working_hours applies; scripts/verify-p1o-scheduling.sql proves the database half with the same cases.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyWorkingHours,
  daypartWindow,
  DEFAULT_SCHEDULING_POLICY,
  policyFromRow,
  proposalExpiry,
  resolveRelativeDate,
  withinWorkingHours,
} from '../src/lib/scheduling/p1o-policy.ts';

const weekdays = { mon: [{ start: '10:00', end: '19:00' }], tue: [{ start: '10:00', end: '19:00' }], wed: [{ start: '10:00', end: '19:00' }], thu: [{ start: '10:00', end: '19:00' }], fri: [{ start: '10:00', end: '19:00' }] };
const policy = policyFromRow({ timezone: 'Asia/Kolkata', working_hours: weekdays, min_notice_minutes: 120, buffer_minutes: 10, durations: [20, 40], proposal_ttl_hours: 24, enforce_working_hours: true, configured: true });

describe('the policy a row describes', () => {
  test('no row is the old hard-coded defaults, and says it is not configured', () => {
    assert.deepEqual(policyFromRow(null), DEFAULT_SCHEDULING_POLICY);
    assert.equal(DEFAULT_SCHEDULING_POLICY.minNoticeMinutes, 60);
    assert.equal(DEFAULT_SCHEDULING_POLICY.bufferMinutes, 15);
    assert.deepEqual(DEFAULT_SCHEDULING_POLICY.durations, [30, 45, 60]);
    assert.equal(DEFAULT_SCHEDULING_POLICY.configured, false);
  });
  test('a row is read field by field, and an unreadable field falls back to the default, never an invented value', () => {
    assert.equal(policy.minNoticeMinutes, 120);
    assert.deepEqual(policy.durations, [20, 40]);
    assert.equal(policy.enforceWorkingHours, true);
    const odd = policyFromRow({ timezone: 7, min_notice_minutes: 'soon', durations: ['a'] });
    assert.equal(odd.timezone, 'Asia/Kolkata');
    assert.equal(odd.minNoticeMinutes, 60);
    assert.deepEqual(odd.durations, [30, 45, 60]);
  });
  test("an offer expires after the policy's hours from the moment it was made", () => {
    const made = new Date('2026-12-01T10:00:00Z');
    assert.equal(proposalExpiry(policy, made).toISOString(), '2026-12-02T10:00:00.000Z');
  });
});

describe('working hours: the same cases the database verifier uses', () => {
  test('Wednesday 10:30 IST is inside Monday-Friday 10-19', () => assert.equal(withinWorkingHours(policy, '2026-12-02T05:00:00Z', '2026-12-02T05:45:00Z'), true));
  test('Sunday is outside', () => assert.equal(withinWorkingHours(policy, '2026-12-06T05:00:00Z', '2026-12-06T05:45:00Z'), false));
  test('a meeting that runs past closing is outside', () => assert.equal(withinWorkingHours(policy, '2026-12-02T13:00:00Z', '2026-12-02T14:00:00Z'), false));
  test('before opening is outside', () => assert.equal(withinWorkingHours(policy, '2026-12-02T03:00:00Z', '2026-12-02T04:00:00Z'), false));
  test('a meeting across midnight local time is outside', () => assert.equal(withinWorkingHours(policy, '2026-12-02T18:00:00Z', '2026-12-02T19:00:00Z'), false));
  test('no hours configured: nothing is outside them', () => assert.equal(withinWorkingHours(DEFAULT_SCHEDULING_POLICY, '2026-12-06T05:00:00Z', '2026-12-06T05:45:00Z'), true));
  test('earliest and latest bounds narrow the day further', () => {
    const narrow = { ...policy, earliestLocalTime: '11:00', latestLocalTime: '17:00' };
    assert.equal(withinWorkingHours(narrow, '2026-12-02T05:00:00Z', '2026-12-02T05:45:00Z'), false);
    assert.equal(withinWorkingHours(narrow, '2026-12-02T06:00:00Z', '2026-12-02T06:45:00Z'), true);
  });
  test('an unreadable instant or zone fails closed', () => {
    assert.equal(withinWorkingHours(policy, 'not a time', '2026-12-02T05:45:00Z'), false);
    assert.equal(withinWorkingHours({ ...policy, timezone: 'Mars/Olympus' }, '2026-12-02T05:00:00Z', '2026-12-02T05:45:00Z'), false);
  });
  test('applying hours only ever shortens the list the calendar answered', () => {
    const slots = [
      { startAt: '2026-12-02T05:00:00Z', endAt: '2026-12-02T05:30:00Z' },
      { startAt: '2026-12-06T05:00:00Z', endAt: '2026-12-06T05:30:00Z' },
    ];
    assert.equal(applyWorkingHours(policy, slots).length, 1);
    assert.equal(applyWorkingHours(DEFAULT_SCHEDULING_POLICY, slots).length, 2);
    assert.deepEqual(applyWorkingHours(policy, []), []);
  });
});

describe('dayparts come from the policy, in English and Hinglish', () => {
  test('evening is the policy window; an unknown word is no daypart', () => {
    assert.deepEqual(daypartWindow(DEFAULT_SCHEDULING_POLICY, 'evening'), { start: '17:00', end: '21:00' });
    assert.deepEqual(daypartWindow(DEFAULT_SCHEDULING_POLICY, 'shaam'), { start: '17:00', end: '21:00' });
    assert.equal(daypartWindow(DEFAULT_SCHEDULING_POLICY, 'night'), null);
    assert.equal(daypartWindow(DEFAULT_SCHEDULING_POLICY, 'teatime'), null);
  });
});

describe('relative dates are read against the AGENCY-local date, never silently moved', () => {
  // 2026-12-02 is a Wednesday. 20:00 UTC on the 2nd is already 01:30 on the 3rd in Kolkata.
  const lateUtc = new Date('2026-12-02T20:00:00Z');
  const noon = new Date('2026-12-02T06:30:00Z');
  test('today and tomorrow follow the local date, not the server date', () => {
    assert.deepEqual(resolveRelativeDate('tomorrow works', lateUtc, 'Asia/Kolkata'), { state: 'date', date: '2026-12-04', basis: 'relative' });
    assert.deepEqual(resolveRelativeDate('tomorrow works', lateUtc, 'UTC'), { state: 'date', date: '2026-12-03', basis: 'relative' });
    assert.deepEqual(resolveRelativeDate('aaj', noon, 'Asia/Kolkata'), { state: 'date', date: '2026-12-02', basis: 'relative' });
  });
  test('day after tomorrow, kal and parso', () => {
    assert.deepEqual(resolveRelativeDate('day after tomorrow please', noon, 'Asia/Kolkata'), { state: 'date', date: '2026-12-04', basis: 'relative' });
    assert.deepEqual(resolveRelativeDate('kal milte hain', noon, 'Asia/Kolkata'), { state: 'date', date: '2026-12-03', basis: 'relative' });
    assert.deepEqual(resolveRelativeDate('parso', noon, 'Asia/Kolkata'), { state: 'date', date: '2026-12-04', basis: 'relative' });
  });
  test("a weekday is the NEXT such day, and today's own name means a week on", () => {
    assert.deepEqual(resolveRelativeDate('friday', noon, 'Asia/Kolkata'), { state: 'date', date: '2026-12-04', basis: 'weekday' });
    assert.deepEqual(resolveRelativeDate('wednesday', noon, 'Asia/Kolkata'), { state: 'date', date: '2026-12-09', basis: 'weekday' });
    assert.deepEqual(resolveRelativeDate('somvar', noon, 'Asia/Kolkata'), { state: 'date', date: '2026-12-07', basis: 'weekday' });
  });
  test('an explicit date is kept; a past one is reported as past and never shifted', () => {
    assert.deepEqual(resolveRelativeDate('on 2026-12-20', noon, 'Asia/Kolkata'), { state: 'date', date: '2026-12-20', basis: 'explicit' });
    assert.deepEqual(resolveRelativeDate('on 2026-11-20', noon, 'Asia/Kolkata'), { state: 'past', date: '2026-11-20' });
  });
  test('a date that is not on the calendar is unclear, not rounded', () => {
    const r = resolveRelativeDate('2026-02-31', noon, 'Asia/Kolkata');
    assert.equal(r.state, 'unclear');
  });
  test('two weekdays in one phrase are unclear; no date at all is none', () => {
    assert.equal(resolveRelativeDate('monday or thursday', noon, 'Asia/Kolkata').state, 'unclear');
    assert.deepEqual(resolveRelativeDate('whenever suits you', noon, 'Asia/Kolkata'), { state: 'none' });
  });
  test("an unreadable zone fails closed rather than falling back to the server's", () => {
    assert.equal(resolveRelativeDate('tomorrow', noon, 'Mars/Olympus').state, 'unclear');
  });
});
