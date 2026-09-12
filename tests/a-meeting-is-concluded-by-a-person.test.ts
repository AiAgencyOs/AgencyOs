import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';
import {
  MEETING_DOORS,
  RECOGNISED_OUTCOMES,
  interpretAnalysis,
  interpretCancel,
  interpretComplete,
  interpretEvidence,
  interpretNoShow,
} from '../src/lib/scheduler/meeting-commands-eval.ts';
import { meetingControls } from '../src/modules/crm/meetings-view.ts';
import { MEETING_STATUSES } from '../src/modules/crm/schema.ts';

/**
 * A meeting is concluded by a person — G-237.
 *
 * The rules live in four SECURITY DEFINER doors and were driven on a scratch
 * Postgres (and are driven in CI by verify-meeting-commands.mjs). What this
 * file holds is the app's side of the contract: every name a door can
 * answer has a sentence, no sentence turns a refusal into a success, and the
 * vocabulary the interpreters know is the vocabulary the migration writes —
 * extracted from the SQL as an array first, so the list here cannot lag it.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const source = read('supabase/migrations/20260912140000_a_meeting_is_concluded_by_a_person.sql');
const migration = sqlCode(source);
const analysisMigration = sqlCode(read('supabase/migrations/20260911170000_what_the_meeting_actually_said.sql'));
const lib = read('src/lib/scheduler/meeting-commands.ts');

/** Every `'name'::text` a function body returns as its first column. */
function outcomesOf(fn: string, sql: string = migration): string[] {
  const start = sql.indexOf(`create or replace function crm.${fn}(`);
  assert.ok(start >= 0, `${fn} is defined`);
  const end = sql.indexOf('$$;', sql.indexOf('as $$', start));
  const body = sql.slice(start, end);
  return [...new Set([...body.matchAll(/return query select '([a-z_]+)'::text/g)].map((m) => m[1]!))].sort();
}

describe('A. the vocabulary is closed on the migration', () => {
  test('each interpreter recognises exactly the names its door can return', () => {
    assert.deepEqual([...RECOGNISED_OUTCOMES.cancel].sort(), outcomesOf('cancel_meeting'));
    assert.deepEqual([...RECOGNISED_OUTCOMES.complete].sort(), outcomesOf('complete_meeting'));
    assert.deepEqual([...RECOGNISED_OUTCOMES.noShow].sort(), outcomesOf('record_no_show'));
    assert.deepEqual([...RECOGNISED_OUTCOMES.evidence].sort(), outcomesOf('add_meeting_evidence'));
    assert.deepEqual([...RECOGNISED_OUTCOMES.analysis].sort(), outcomesOf('request_meeting_analysis', analysisMigration));
    assert.ok(outcomesOf('complete_meeting').length >= 10, 'the extraction found the whole list');
  });

  test('the doors the view offers are the doors the migrations define and the rpc names the lib calls — one table', () => {
    // Review: the first draft carried the names in the view, the lib and the
    // tests with nothing joining them, so a renamed door would leave the page
    // naming a function that no longer existed.
    for (const [door, { rpc }] of Object.entries(MEETING_DOORS)) {
      assert.equal(door, `crm.${rpc}`, `${door} names its own rpc`);
      const defined = migration.includes(`create or replace function crm.${rpc}(`) || analysisMigration.includes(`create or replace function crm.${rpc}(`);
      assert.ok(defined, `${door} is defined by a migration`);
    }
    assert.match(lib, /\.rpc\(MEETING_DOORS\[door\]\.rpc/, 'the lib calls through the table, never a literal');
    assert.doesNotMatch(lib, /\.rpc\('/, 'no rpc literal bypasses the table');
    const offered = new Set(MEETING_STATUSES.flatMap((st) => meetingControls(st).map((c) => c.door)).filter((d): d is keyof typeof MEETING_DOORS => d !== null));
    assert.deepEqual([...offered].sort(), Object.keys(MEETING_DOORS).sort(), 'every door is offered by some status, and nothing offered is not a door');
  });

  test('a name nobody planned for is said as itself, and is never a success', () => {
    for (const d of [interpretCancel('surprise', null), interpretComplete('surprise', null), interpretNoShow('surprise'), interpretEvidence('surprise'), interpretComplete(undefined, null)]) {
      assert.equal(d.kind, 'error');
      assert.match(d.message, /surprise|nothing/);
    }
  });
});

describe('B. only the recorded conclusions are successes', () => {
  test('cancel: cancelled and already_cancelled are done; the provider event is said to be NOT cancelled', () => {
    const withEvent = interpretCancel('cancelled', 'evt-1');
    assert.equal(withEvent.kind, 'done');
    assert.match(withEvent.message, /evt-1 was NOT cancelled there/);
    assert.match(withEvent.message, /BLK-005/);
    assert.equal(interpretCancel('cancelled', null).kind, 'done');
    assert.equal(interpretCancel('already_cancelled', null).kind, 'done');
    for (const name of ['wrong_state', 'forbidden', 'not_found']) assert.equal(interpretCancel(name, null).kind, 'error', name);
  });

  test('complete: done says whether analysis was queued, and that no worker runs it; every refusal is a refusal', () => {
    assert.match((interpretComplete('completed', 'queued') as { message: string }).message, /queued.*BLK-001/);
    assert.match((interpretComplete('completed', 'no_evidence') as { message: string }).message, /No analysis was queued/);
    assert.equal(interpretComplete('already_completed', null).kind, 'done');
    for (const name of RECOGNISED_OUTCOMES.complete.filter((n) => n !== 'completed' && n !== 'already_completed')) {
      const d = interpretComplete(name, null);
      assert.equal(d.kind, 'error', name);
    }
    // The one a well-meaning operator hits: a meeting cannot have happened before it began.
    const early = interpretComplete('not_yet_started', null);
    assert.equal(early.kind, 'error');
    assert.match(early.message, /not reached its agreed start/);
    // A worker is refused by name, not by a generic forbidden.
    assert.match((interpretComplete('no_actor', null) as { message: string }).message, /concluded by a person/);
  });

  test('no-show: done says no follow-up was queued and names the open decision', () => {
    const d = interpretNoShow('no_show');
    assert.equal(d.kind, 'done');
    assert.match(d.message, /No follow-up was queued.*ADM-103/);
    for (const name of RECOGNISED_OUTCOMES.noShow.filter((n) => n !== 'no_show' && n !== 'already_recorded')) {
      assert.equal(interpretNoShow(name).kind, 'error', name);
    }
  });

  test('evidence: attached is done; nothing_to_attach is refused with the reason', () => {
    assert.equal(interpretEvidence('attached').kind, 'done');
    assert.match((interpretEvidence('nothing_to_attach') as { message: string }).message, /claim that evidence exists/);
    for (const name of RECOGNISED_OUTCOMES.evidence.filter((n) => n !== 'attached')) assert.equal(interpretEvidence(name).kind, 'error', name);
  });

  test('analysis: queued and already_queued are done and say no worker runs it; no_evidence and not_completed are refusals with the reason', () => {
    assert.match((interpretAnalysis('queued') as { message: string }).message, /BLK-001/);
    assert.equal(interpretAnalysis('already_queued').kind, 'done');
    assert.match((interpretAnalysis('no_evidence') as { message: string }).message, /Attach evidence first/);
    assert.match((interpretAnalysis('not_completed') as { message: string }).message, /no-show has nothing to analyse/);
    for (const name of RECOGNISED_OUTCOMES.analysis.filter((n) => n !== 'queued' && n !== 'already_queued')) assert.equal(interpretAnalysis(name).kind, 'error', name);
  });
});

describe('C. what the migration holds at the row', () => {
  test('a zone Postgres does not know is refused by a trigger on insert and on a change of the column, through one case-insensitive predicate', () => {
    assert.match(migration, /create trigger meetings_timezone_is_known\s+before insert or update of timezone on crm\.meetings/);
    assert.match(migration, /lower\(z\.name\) = lower\(p_zone\)/, 'core.is_known_timezone compares as Postgres resolves');
    assert.match(migration, /new\.timezone is not distinct from old\.timezone/, 'an unchanged value is not re-scanned');
    assert.equal((migration.match(/from pg_catalog\.pg_timezone_names/g) ?? []).length, 1, 'pg_timezone_names is read in exactly one place');
  });

  test('a conclusion before the agreed start is refused at the row, not only by the doors', () => {
    // Review: the doors answered not_yet_started by name while a direct PATCH
    // to status=completed landed on a meeting booked for tomorrow.
    assert.match(migration, /create trigger meetings_conclude_after_start\s+before update of status on crm\.meetings/);
    assert.match(migration, /clock_timestamp\(\) < new\.confirmed_start_at/);
    assert.match(migration, /coalesce\(new\.completed_at, clock_timestamp\(\)\) < new\.confirmed_start_at/);
  });

  test('book_meeting is carried forward with exactly one marked edit, answering invalid_timezone by name from its handler', () => {
    // The marker is a comment, which sqlCode strips: read the source for it.
    assert.equal((source.match(/\[G-237 edit 1 of 1\]/g) ?? []).length, 1);
    assert.ok(outcomesOf('book_meeting').includes('invalid_timezone'));
    assert.match(migration, /when check_violation then\s+if sqlerrm like 'meeting_timezone:%'/);
  });

  test('a worker cannot conclude a meeting: complete and no-show refuse a null auth.uid() before reading the row', () => {
    for (const fn of ['complete_meeting', 'record_no_show']) {
      const start = migration.indexOf(`create or replace function crm.${fn}(`);
      const body = migration.slice(start, migration.indexOf('$$;', start));
      const refusal = body.indexOf("'no_actor'::text");
      const read = body.indexOf('select m.* into v_row');
      assert.ok(refusal > 0 && refusal < read, `${fn} refuses no_actor before the read`);
    }
  });

  test('an authenticated caller needs the write the row policy demands — can_write, never is_internal', () => {
    // Review: the first draft admitted a contractor the row itself refuses.
    assert.equal((migration.match(/core\.can_write\(\)/g) ?? []).length, 4, 'one guard per door');
    assert.doesNotMatch(migration, /core\.is_internal\(\)/);
  });

  test('a note is filed through the evidence door — one insert path, one audit — and every door returns the lead', () => {
    assert.equal((migration.match(/from crm\.add_meeting_evidence\(v_row\.id, 'notes', p_note, 'internal'\)/g) ?? []).length, 2);
    assert.doesNotMatch(migration, /insert into crm\.meeting_evidence[\s\S]*insert into crm\.meeting_evidence/, 'exactly one insert into meeting_evidence');
    for (const fn of ['cancel_meeting', 'complete_meeting', 'record_no_show', 'add_meeting_evidence']) {
      const start = migration.indexOf(`create or replace function crm.${fn}(`);
      const head = migration.slice(start, migration.indexOf('language plpgsql', start));
      assert.match(head, /lead_id\s+uuid/, `${fn} returns lead_id`);
    }
  });
});
