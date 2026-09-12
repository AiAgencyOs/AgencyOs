import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';
import { interpretReschedule } from '../src/lib/scheduler/meeting-commands-eval.ts';

/**
 * A reschedule is a new row — G-244, Scheduler §8 in G-225's shape. The door
 * is driven live by verify-reschedule.mjs; this holds the sentences and where
 * the controls sit.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const migration = sqlCode(read('supabase/migrations/20260913150000_a_reschedule_is_a_new_row.sql'));
const LIB = codeOnly(read('src/lib/scheduler/meeting-commands.ts'));

describe('A. the door, in one transaction', () => {
  test('only a booking; the old row cancelled with a reason that says rescheduled; the new row minted with supersedes_id and what identifies the meeting', () => {
    assert.match(migration, /if v_row\.status <> 'booked' then/);
    assert.match(migration, /cancellation_reason = left\('rescheduled' \|\| coalesce\(': ' \|\| v_reason, ''\), 2000\)/);
    assert.match(migration, /timezone, duration_minutes, purpose, created_by, supersedes_id, status/);
    assert.match(migration, /coalesce\(v_mode, v_row\.booked_mode, v_row\.requested_mode\)/, 'the mode the client now asks for, else what was booked, else what was first asked');
    assert.match(migration, /'meeting\.rescheduled'/);
    assert.equal((migration.match(/core\.can_write\(\)/g) ?? []).length, 1);
  });
});

describe('B. the sentences, and the provider event taken back once for cancel and reschedule alike', () => {
  test('rescheduled names the new row; every refusal is a refusal', () => {
    assert.match((interpretReschedule('rescheduled', '12345678-aaaa') as { message: string }).message, /new meeting \(12345678\) is requested in its place/);
    for (const name of ['wrong_state', 'invalid_request', 'unknown_actor', 'forbidden', 'not_found', 'surprise']) assert.equal(interpretReschedule(name, null).kind, 'error', name);
  });
  test('one take-back helper, used by cancel and by reschedule, writing its own audit row', () => {
    assert.equal((LIB.match(/await takeProviderEventBack\(/g) ?? []).length, 2);
    assert.match(LIB, /p_action: 'meeting\.provider_event_cancelled'/);
    assert.equal((LIB.match(/calendar\.cancelEvent\(/g) ?? []).length, 1, 'the adapter is asked in one place');
  });
});
