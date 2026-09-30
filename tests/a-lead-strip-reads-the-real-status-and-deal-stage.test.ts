import assert from 'node:assert/strict';
import { test } from 'node:test';

import { leadStageStrip } from '@/lib/admin/lead-stage-strip';

const states = (leadStatus: string, dealStage: string | null) => leadStageStrip({ leadStatus, dealStage }).segments.map((s) => s.state);

test('a new lead has only its first segment current', () => {
  assert.deepEqual(states('new', null), ['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
});

test('a qualified lead with a deal in proposal is at Quoted with everything before it done', () => {
  assert.deepEqual(states('qualified', 'proposal'), ['done', 'done', 'done', 'current', 'upcoming', 'upcoming', 'upcoming']);
});

test('a converted lead has every earlier segment done', () => {
  assert.deepEqual(states('converted', 'won'), ['done', 'done', 'done', 'done', 'done', 'current', 'upcoming']);
});

test('a lost deal or a disqualified lead lands on Lost and marks nothing done', () => {
  assert.deepEqual(states('qualified', 'lost')[6], 'lost');
  assert.equal(states('disqualified', null).filter((s) => s === 'done').length, 0);
});

test('a nurtured lead is parked, off the path, with no current segment', () => {
  const strip = leadStageStrip({ leadStatus: 'nurture', dealStage: null });
  assert.equal(strip.parked, true);
  assert.ok(strip.segments.every((s) => s.state === 'upcoming'));
});
