import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * A paused thread gets no nudge — G-241, Doc 09 §7 and §36.
 *
 * The rule is driven live by verify-follow-up-worker §14 (the pause, the
 * block, the un-pause, the send). What this file holds is where it sits: the
 * fact comes from the due list, read from the thread's own row and never
 * claimed; the block is placed with the other blocks — before the claim, so
 * nothing is spent — and only for a situation that reaches a client.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const source = read('supabase/migrations/20260913120000_a_paused_thread_gets_no_nudge.sql');
const migration = sqlCode(source);
const WORKER = codeOnly(read('src/modules/crm/follow-up-worker.ts'));

describe('A. the due list carries the fact, from the thread', () => {
  test('one marked edit: thread_paused_at, read through a left join on the conversation', () => {
    assert.equal((source.match(/\[G-241 edit 1 of 1\]/g) ?? []).length, 2, 'the column and its value, both marked as the one edit');
    assert.match(migration, /thread_paused_at timestamptz\s*\)/);
    assert.match(migration, /left join crm\.conversations c on c\.id = s\.conversation_id/);
    assert.match(migration, /c\.agent_paused_at\s+from crm\.follow_up_sequences s/);
    assert.match(migration, /drop function if exists crm\.due_follow_up_sequences\(int\);/, 'a new column changes the return type; dropped first, as its predecessor was');
    assert.match(migration, /grant execute on function crm\.due_follow_up_sequences\(int\) to service_role;/, 'and the grant re-established');
  });
});

describe('B. the worker blocks on it, by name, before anything is spent', () => {
  test('the block sits after the timezone block and before the subject read and the claim, and only for a client situation', () => {
    const block = WORKER.indexOf("noteBlock(admin, seq.sequence_id, 'thread_waiting_for_a_person')");
    const timezone = WORKER.indexOf("noteBlock(admin, seq.sequence_id, 'timezone_unavailable');\n      outcome.blocked += 1;");
    const subject = WORKER.indexOf('const subject = await readSubject(admin, seq);');
    assert.ok(timezone > 0 && timezone < block && block < subject, 'timezone block → pause block → subject read');
    assert.match(WORKER, /if \(situation\.audience !== 'internal' && seq\.thread_paused_at\) \{\s*await noteBlock\(admin, seq\.sequence_id, 'thread_waiting_for_a_person'\);\s*outcome\.blocked \+= 1;\s*continue;/);
  });

  test('the row type carries the column the due list now returns', () => {
    assert.match(WORKER, /thread_paused_at: string \| null;/);
  });
});
