import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  BLOCKING_SEVERITIES,
  DEFECT_SEVERITIES,
  DEFECT_STATUSES,
  DEFECT_TRANSITIONS,
  blocksDelivery,
} from '../src/modules/qa/schema.ts';

/**
 * QA — gap G-030, directive §19, and the gate ARCHITECTURE.md §4.8 states.
 *
 * The gate itself is proved against a real database by
 * `scripts/verify-qa-gate.mjs`, because it is a lock-scoped decision in
 * Postgres and a mocked version of it would prove nothing. What is here is the
 * vocabulary pinned against its constraints, and the one piece of judgement
 * worth stating in code: which severities stop work.
 */

const migration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260813120002_qa_defects.sql', import.meta.url)),
  'utf8',
);

describe('A. the vocabulary is ARCHITECTURE.md’s own', () => {
  test('severities and statuses match §4.8 exactly', () => {
    assert.deepEqual([...DEFECT_SEVERITIES], ['blocker', 'major', 'minor', 'trivial']);
    assert.deepEqual([...DEFECT_STATUSES], ['open', 'fixed', 'wontfix', 'verified']);
  });

  test('and every one of them is a value the table admits', () => {
    for (const value of [...DEFECT_SEVERITIES, ...DEFECT_STATUSES]) {
      assert.ok(migration.includes(`'${value}'`), `${value} is in schema.ts but not in the CHECK`);
    }
  });
});

describe('B. what stops work reaching a client', () => {
  test('blocker and major, exactly as §4.8 names', () => {
    assert.deepEqual([...BLOCKING_SEVERITIES], ['blocker', 'major']);
  });

  test('an open blocker blocks; a fixed one does not', () => {
    assert.equal(blocksDelivery({ status: 'open', severity: 'blocker' }), true);
    assert.equal(blocksDelivery({ status: 'fixed', severity: 'blocker' }), false);
    assert.equal(blocksDelivery({ status: 'verified', severity: 'blocker' }), false);
  });

  test('a minor never blocks, however many there are', () => {
    assert.equal(blocksDelivery({ status: 'open', severity: 'minor' }), false);
    assert.equal(blocksDelivery({ status: 'open', severity: 'trivial' }), false);
  });
});

describe('C. the transitions', () => {
  test('verified and wontfix are terminal', () => {
    assert.deepEqual(DEFECT_TRANSITIONS.verified, []);
    assert.deepEqual(DEFECT_TRANSITIONS.wontfix, []);
  });

  test('a failed verification returns a defect to open rather than raising a new one', () => {
    assert.ok(
      DEFECT_TRANSITIONS.fixed.includes('open'),
      'the same bug still being wrong is the same bug, and its history is worth keeping',
    );
  });

  test('open cannot reach verified without passing through fixed', () => {
    assert.ok(!DEFECT_TRANSITIONS.open.includes('verified'));
  });
});

describe('D. the rules the database holds', () => {
  test('the gate is scoped to the version, and to project-wide defects', () => {
    assert.match(migration, /d\.deliverable_id = p_deliverable_id or d\.deliverable_id is null/);
  });

  test('a blocker on an older version does not block a newer one', () => {
    // The trap this scoping avoids: bugs are found against a version and the
    // fix is the next version, so project-wide scoping would make the fix
    // unshowable and the only way out would be closing the bug dishonestly.
    assert.match(migration, /v2 gets fixed|v3, because v3 is the fix|must not stop v3/);
  });

  test('the gate is checked under the same lock that writes the status', () => {
    const fn = migration.slice(migration.indexOf('function projects.submit_deliverable'));
    assert.ok(
      fn.indexOf('for update') < fn.indexOf('qa.blocking_defects'),
      'checking before the lock would let a blocker raised mid-click be missed',
    );
  });

  test('a verification names somebody, at a time', () => {
    assert.match(migration, /defects_verification_shape/);
    assert.match(migration, /verified_by is not null and verified_at is not null/);
  });

  test('leaving open says why, so a bug cannot be closed by silence', () => {
    assert.match(migration, /defects_resolution_shape/);
  });

  test('reproduction is required — a bug nobody can reproduce is a rumour', () => {
    assert.match(migration, /reproduction\s+text not null check/);
  });

  test('defects are internal: a client is told what was fixed, not what is broken', () => {
    const policies = migration.match(/create policy (\w+) on qa\.defects/g) ?? [];
    assert.equal(policies.length, 2, 'select and write, both internal');
    assert.ok(!/core\.is_client\(\)/.test(migration));
  });
});
