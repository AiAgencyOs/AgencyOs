// P4-PM-018 / P4-FIN-003 / P4-FIN-009. Behavioural check of the round key, and
// source-level pins for the two M2 row-authority guards (the state itself is
// read from projects.phase_four).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { roundKeyFor } from '../src/modules/crm/handlers.ts';

test('two UI revision rounds of one workspace get two different announcement keys', () => {
  const a = roundKeyFor({ subjectId: '11111111-1111-4111-8111-111111111111' });
  const b = roundKeyFor({ subjectId: '22222222-2222-4222-8222-222222222222' });
  assert.notEqual(a, b);
  assert.equal(a, roundKeyFor({ subjectId: '11111111-1111-4111-8111-111111111111' }), 'a replay of the same round keeps its key');
});

test('without a subject the key falls back to the event id, never to a constant shared by every round', () => {
  assert.equal(roundKeyFor({ eventId: 7 }), 'e7');
  assert.notEqual(roundKeyFor({ eventId: 7 }), roundKeyFor({ eventId: 8 }));
});

test('generateM2Invoice re-reads the Task 2 workspace and refuses without an active receiving account', () => {
  const src = readFileSync('src/modules/finance/service.ts', 'utf8');
  const start = src.indexOf('export async function generateM2Invoice');
  const next = src.indexOf('\nexport ', start + 10);
  assert.ok(start > 0 && next > start, 'function bounds found');
  const body = src.slice(start, next);
  assert.match(body, /\.from\('phase_four'\)[\s\S]*?workspace\.state !== 'completed'/);
  assert.match(body, /from\('payment_accounts'\)[\s\S]*?\.eq\('status', 'active'\)/);
  assert.match(body, /if \(!activeAccounts\)/);
});
