import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mayAgentRun } from '../src/lib/ai/autonomy.ts';

/**
 * The roster is set to the owner's answer — ADM-82's activation, BLK-002.
 *
 * What is asserted here is the ANSWER and its consequences, including the two
 * consequences that are easy to state wrongly: that this changes no behaviour,
 * and that L1 is the more permissive level rather than the less.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260914120000_the_roster_is_set_to_the_owners_answer.sql');
const WORKFLOWS = read('app/api/jobs/run/workflows.ts');
/** The migration's prose with its comment markers folded away, so an assertion is not a claim about line wrapping. */
const PROSE = MIGRATION.replace(/\n--\s?/g, ' ');

/** The owner's answer, 2026-09-13, transcribed. */
const ANSWER = {
  L1: ['requirement_collector', 'sales', 'customer_success', 'support', 'handover'],
  L2: ['quality_assurance', 'project_manager', 'ui_designer', 'ui_prototype'],
  off: ['orchestrator', 'developer', 'finance', 'upsell'],
} as const;

describe('A. the three rows that move, and only those three', () => {
  test('ui_prototype is enabled, handover becomes L1, project_manager becomes L2', () => {
    assert.match(MIGRATION, /set enabled\s+= true,\s*\n\s*disabled_reason = null\s*\n\s*where key = 'ui_prototype';/);
    assert.match(MIGRATION, /set autonomy_level = 'L1'\s*\n\s*where key = 'handover';/);
    assert.match(MIGRATION, /set autonomy_level = 'L2'\s*\n\s*where key = 'project_manager';/);
  });

  test('no enabled agent is switched off, and no agent the answer omits is switched on', () => {
    // The four the answer names OFF are the only keys with `enabled = false`.
    const offKeys = [...MIGRATION.matchAll(/set enabled = false,[\s\S]*?where key = '([a-z_]+)';/g)].map((m) => m[1]);
    assert.deepEqual(offKeys.sort(), [...ANSWER.off].sort());
    // And the only key enabled here is the one that was not.
    const onKeys = [...MIGRATION.matchAll(/set enabled\s+= true,[\s\S]*?where key = '([a-z_]+)';/g)].map((m) => m[1]);
    assert.deepEqual(onKeys, ['ui_prototype']);
  });

  test('the two folded-in definitions are not resurrected', () => {
    // ADM-82: lead_qualifier and proposal_drafter are not independent runtime
    // agents. Nothing here may enable them, deliberately or by a wide UPDATE.
    for (const key of ['lead_qualifier', 'proposal_drafter']) {
      assert.doesNotMatch(MIGRATION, new RegExp(`where key = '${key}'`), `${key} must be left alone`);
    }
    assert.doesNotMatch(MIGRATION, /update ai\.agents\s*\n\s*set enabled\s*=\s*true;/, 'no unqualified enable');
  });
});

describe('B. it changes no behaviour, and says so', () => {
  test('ui_prototype has no workflow, so being enabled runs nothing', () => {
    const keys = new Set([...WORKFLOWS.matchAll(/agentKey: '([a-z_]+)'/g)].map((m) => m[1]));
    assert.equal(keys.has('ui_prototype'), false, 'a workflow appeared — this test and the migration’s claim are now stale');
    // The eight that do have one are exactly the eight already enabled before
    // this migration, which is why nothing starts running because of it.
    for (const key of ['requirement_collector', 'sales', 'customer_success', 'support', 'handover', 'quality_assurance', 'project_manager', 'ui_designer']) {
      assert.ok(keys.has(key), `${key} lost its workflow`);
    }
  });

  test('both level changes are between levels that permit the work in question', () => {
    // handover.package is a draft; plan.breakdown is a breakdown.
    assert.ok(mayAgentRun('L1', 'draft').allowed && mayAgentRun('L2', 'draft').allowed);
    assert.ok(mayAgentRun('L1', 'breakdown').allowed && mayAgentRun('L2', 'breakdown').allowed);
  });

  test('and the migration states it rather than leaving it to be discovered', () => {
    assert.match(PROSE, /It changes no behaviour/);
    assert.match(PROSE, /What BLK-002 actually blocks is a BUILD/);
  });
});

describe('C. the inversion the levels carry', () => {
  test('L1 permits every work class and L2 only four — so L1 is the permissive one', () => {
    for (const work of ['read', 'draft', 'internal_plan', 'breakdown', 'client_facing', 'money', 'delivery_approval']) {
      assert.equal(mayAgentRun('L1', work).allowed, true, `L1 refused ${work}`);
    }
    for (const work of ['read', 'draft', 'internal_plan', 'breakdown']) {
      assert.equal(mayAgentRun('L2', work).allowed, true, `L2 refused ${work}`);
    }
    for (const work of ['client_facing', 'money', 'delivery_approval']) {
      assert.equal(mayAgentRun('L2', work).allowed, false, `L2 permitted ${work}`);
    }
  });

  test('which means moving an agent from L2 to L1 WIDENS it — recorded, not hidden', () => {
    const widened = mayAgentRun('L2', 'client_facing').allowed === false && mayAgentRun('L1', 'client_facing').allowed === true;
    assert.ok(widened, 'the inversion this migration warns about no longer exists — update the comment and G-247');
    assert.match(PROSE, /L1 is therefore the MORE permissive level/);
    assert.match(PROSE, /G-247/);
  });

  test('and L1 does not mean a person approves — two sales workflows reach the client unread', () => {
    // ADM-11 and ADM-91, the owner's own grants. The level permits the run;
    // whether anybody reads the result is the workflow's property.
    for (const kind of ['followup.compose', 'reply.compose']) {
      const at = WORKFLOWS.indexOf(`jobKind: '${kind}'`);
      assert.ok(at > 0, `${kind} is gone`);
      assert.match(WORKFLOWS.slice(at, at + 2000), /workClass: 'client_facing'/, `${kind} changed work class`);
    }
    assert.match(PROSE, /reach the client unread, by ADM-11 and ADM-91/);
  });
});
