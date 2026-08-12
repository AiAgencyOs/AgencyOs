import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Handover — Phase 12, gap G-032, directive §22.
 *
 * The behaviour is proved against a real database by
 * `scripts/verify-handover.mjs`. What is pinned here is the one rule that must
 * never be softened by a well-meaning future change: **this table cannot hold
 * a credential.** A column with a client's production password in it is the
 * same leak as the WhatsApp message directive §22 forbids, with a longer
 * retention period and a backup schedule.
 */

const migration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260813120003_handover.sql', import.meta.url)),
  'utf8',
);

describe('A. the credentials rule', () => {
  test('a credential item may carry no reference, and must say how it was transferred', () => {
    assert.match(migration, /handover_items_credential_shape/);
    assert.match(migration, /kind <> 'credential'\s*\n?\s*or \(reference is null/);
  });

  test('no column exists that could hold a secret value', () => {
    // Comments stripped first: the table's own comment explains *why* a
    // password column would be wrong, and an earlier version of this test
    // failed on the word in that explanation.
    const table = migration
      .slice(
        migration.indexOf('create table if not exists projects.handover_items'),
        migration.indexOf('comment on table projects.handover_items'),
      )
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    for (const forbidden of ['password', 'secret', 'token', 'api_key', 'credential_value']) {
      assert.ok(!table.includes(forbidden), `handover_items grew a ${forbidden} column`);
    }
  });

  test('the rule is in DDL, not in a service that could forget it', () => {
    assert.match(migration, /constraint handover_items_credential_shape check/);
  });
});

describe('B. what is refused', () => {
  test('an empty package — it would claim nothing was delivered', () => {
    assert.match(migration, /'empty'::text/);
  });

  test('delivery while an open blocker or major defect stands', () => {
    assert.match(migration, /severity in \('blocker', 'major'\)/);
    assert.match(migration, /'blocked'::text/);
  });

  test('editing a package after it was delivered', () => {
    assert.match(migration, /handover_items_guard/);
    assert.match(migration, /prepare another rather than changing what was delivered/);
  });

  test('a second live handover for one project', () => {
    assert.match(migration, /handovers_open_project_key[\s\S]*?where status in \('preparing', 'delivered'\)/);
  });
});

describe('C. what is deliberately NOT refused', () => {
  /**
   * Directive §21 says handover follows final payment. Which payment is final
   * is the project's own plan, and encoding that here would put an invented
   * gate in front of real revenue — ADM-13/ADM-14, the same reason G-100 is
   * open. The balance is reported so a human sees it.
   */
  test('an outstanding balance is reported, never enforced', () => {
    assert.match(migration, /outstanding_minor bigint/);
    assert.ok(
      !/if v_outstanding > 0 then[\s\S]{0,200}return query select 'unpaid'/.test(migration),
      'a payment gate appeared without ADM-13/ADM-14 having been answered',
    );
    assert.match(migration, /Reported, never enforced/);
  });
});

describe('D. acceptance is the client’s, through the engine', () => {
  test('handover is a subject type the approval engine now carries', () => {
    assert.match(migration, /'ticket_plan', 'handover'/);
  });

  test('and the acceptance is client-audience, so ADM-08d’s evidence rule applies', () => {
    const fn = migration.slice(migration.indexOf('function projects.deliver_handover'));
    assert.match(fn.slice(0, 4000), /'client'/);
  });

  test('a client sees a delivered handover, never one still being prepared', () => {
    assert.match(migration, /core\.is_client\(\)[\s\S]{0,200}status <> 'preparing'/);
  });
});
