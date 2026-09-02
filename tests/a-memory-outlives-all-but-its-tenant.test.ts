import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * A memory outlives all but its tenant — G-190.
 *
 * ── the contradiction ─────────────────────────────────────────────────────
 *
 * Doc 05 §32: *a memory is superseded, never deleted.* The trigger enforced it
 * as an absolute — every DELETE raises, for every caller, service role
 * included. And `ai.memory_records.organization_id` is declared `on delete
 * cascade`.
 *
 * Both cannot be true. **An organization that had ever been remembered about
 * could not be deleted at all**, because the cascade raises — so tenant
 * offboarding was impossible and nothing said so.
 *
 * ── how it surfaced, which is the part worth keeping ─────────────────────
 *
 * As a test-fixture problem. G-189's new section creates a second agency,
 * writes ten memories under it, and deletes it in a `finally` — the delete
 * raised, a `.catch(() => {})` swallowed it, and two later scripts in the CI
 * chain failed on the leftover organization. **A cleanup that cannot fail is a
 * cleanup nobody can see failing**, so it is loud now.
 *
 * ── what §32 actually protects ────────────────────────────────────────────
 *
 * Rewriting history: a person or an agent must not remove what was
 * remembered, because a memory that can be deleted is a memory that can be
 * made convenient. It says nothing about the tenant ceasing to exist — and
 * when the organization goes, everything it owned goes with it, which is what
 * the foreign key already declared.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION_RAW = read('supabase/migrations/20260902150000_a_memory_outlives_all_but_its_tenant.sql');
const MIGRATION = sqlCode(MIGRATION_RAW);
const VERIFIER = codeOnly(read('scripts/verify-memory.mjs'));

describe('A. the one exception, and how it is told apart', () => {
  test('a delete whose organization is already gone is a cascade, and passes', () => {
    assert.match(
      MIGRATION,
      /if not exists \(\s*select 1 from core\.organizations o where o\.id = old\.organization_id\s*\) then\s*return old;/,
    );
  });

  test('and every other delete still raises §32', () => {
    assert.match(MIGRATION, /raise exception 'a memory is superseded, never deleted \(Doc 05 §32\)'/);
  });

  test('the discriminator is stated as measured, not as assumed', () => {
    assert.match(MIGRATION_RAW, /During a cascade the parent row is \*\*already gone\*\* by the time this trigger\n-- runs — measured on this database rather than assumed/);
  });
});

describe('B. the three refusals beside it are untouched', () => {
  test('regenerated from the live definition, not retyped', () => {
    // G-126: a hand-rewritten function drops a branch and every structural
    // test stays green.
    for (const rule of [
      'a superseded memory stays superseded',
      'a superseded memory is history; write a new one instead',
      'an agent-authored memory cannot become explicit',
    ]) {
      assert.ok(MIGRATION.includes(rule), `${rule} must survive`);
    }
    assert.match(MIGRATION_RAW, /REGENERATED FROM THE LIVE DEFINITION, not retyped/);
  });

  test('and the trigger still stamps updated_at, which is its other job', () => {
    assert.match(MIGRATION, /new\.updated_at := now\(\);/);
  });
});

describe('C. the cleanup that hid it cannot hide anything now', () => {
  test('the verifier asserts its own teardown instead of swallowing it', () => {
    assert.ok(!VERIFIER.includes("organizations?id=eq.${id}`, undefined, 'core').catch("));
    assert.match(VERIFIER, /check\(gone\.ok, 'the second agency is removed, and its memories with it'/);
  });

  test('and asserts that nothing is left for the next script in the chain', () => {
    // The two failures this caused were in OTHER scripts: one requires exactly
    // one organization, the other picked the wrong one and hit a tenancy
    // guard. Residue is never only its own script's problem.
    assert.match(VERIFIER, /nothing of it is left for the next script in the chain to trip over/);
  });

  test('the direct-delete refusal is still asserted, so the pair is complete', () => {
    assert.match(VERIFIER, /'and no memory is deleted at all'/);
  });
});
