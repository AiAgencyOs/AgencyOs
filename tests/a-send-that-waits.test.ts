import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';
import {
  describeBacklog,
  severityOf,
  signatureOf,
  type BacklogRow,
} from '../src/lib/observability/backlog.ts';

/**
 * A send that waits is work nobody is doing — gap G-220.
 *
 * G-214 gave this system a way for a send to WAIT, and G-216 a second kind.
 * Both are right. Both were invisible: `core.operational_backlog()` decides
 * whether anybody is told anything, and it did not know they existed. An
 * approved quotation could sit parked for thirty days with no trace but a row
 * in a table nobody opens.
 *
 * The hard part is not counting them. MOST of this waiting is correct and
 * must never raise an alert — a quotation waiting for a client who has not
 * written back is the design working. What is worth telling somebody is the
 * waiting THEY can end.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260906180000_a_send_that_waits_is_work_nobody_is_doing.sql'));

const clean: BacklogRow = {
  dead_jobs: 0, stalled_jobs: 0, stuck_queued_jobs: 0, unpublished_events: 0, dead_events: 0,
  overdue_approvals: 0, unannounced_approvals: 0,
  sends_waiting_on_admin: 0, sends_waiting_on_reply: 0,
  oldest_dead_at: null, oldest_unpublished_at: null, oldest_overdue_due_at: null,
  oldest_unannounced_at: null, oldest_waiting_on_admin_at: null,
};

describe('A. only the waiting somebody can end is a problem', () => {
  test('a send with nothing approved to carry it degrades the system', () => {
    assert.equal(severityOf({ ...clean, sends_waiting_on_admin: 1 }), 'degraded');
  });

  /**
   * The absence this gap turns on, with its twin above. A quotation waiting
   * for a client who has not written back is the design working, and an alert
   * that fires on the feature is how somebody learns to ignore alerts.
   */
  test('and a send waiting for a client to reply does not', () => {
    assert.equal(severityOf({ ...clean, sends_waiting_on_reply: 400 }), 'clear');
  });

  test('degraded, not failing — nothing is lost and one action releases all of it', () => {
    assert.notEqual(severityOf({ ...clean, sends_waiting_on_admin: 9 }), 'failing');
  });
});

describe('B. the alert does not flap', () => {
  test('the fingerprint moves when the actionable count moves', () => {
    assert.notEqual(signatureOf(clean), signatureOf({ ...clean, sends_waiting_on_admin: 1 }));
  });

  /**
   * `sends_waiting_on_reply` changes every time a client writes. In the
   * fingerprint it would make every reply look like a new situation, which is
   * exactly the flapping the cooldown exists to prevent.
   */
  test('and does NOT move when a client replies', () => {
    assert.equal(signatureOf(clean), signatureOf({ ...clean, sends_waiting_on_reply: 37 }));
  });
});

describe('C. it says what to do about it', () => {
  test('the message names the action, not the symptom', () => {
    const lines = describeBacklog({ ...clean, sends_waiting_on_admin: 3 });
    const line = lines.find((l) => l.includes('waiting because no approved'));
    assert.ok(line, 'the waiting sends are not described at all');
    assert.match(line!, /registers one/);
  });

  test('and says nothing at all when there is nothing to say', () => {
    assert.deepEqual(describeBacklog({ ...clean, sends_waiting_on_reply: 500 }), []);
  });
});

describe('D. the classification is set, never inferred', () => {
  test('the caller says which kind of waiting this is', () => {
    assert.match(SQL, /p_blocked_on text default 'window'/);
    assert.match(SQL, /blocked_on text not null default 'window'/);
  });

  test('and only three kinds exist', () => {
    assert.match(SQL, /blocked_on in \(\s*\n?\s*'window',[\s\S]{0,200}?'no_template',[\s\S]{0,200}?'limit'/);
  });

  /**
   * A count derived from free text changes when somebody rewords a sentence.
   * The backlog must never read `reason`.
   */
  test('the backlog counts the column, never the prose', () => {
    const fn = SQL.slice(SQL.indexOf('create function core.operational_backlog'));
    assert.match(fn, /blocked_on = 'no_template'/);
    assert.doesNotMatch(fn, /reason like|reason ilike|reason ~/);
  });
});
