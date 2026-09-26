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

describe('B. it changed no behaviour THEN — and names the day that stopped being true', () => {
  test('ui_prototype had no workflow when this migration landed; it has one now (Phase 4 gap-analysis step 4)', () => {
    // This test used to assert ui_prototype had NO workflow, and said so in
    // its own failure message: "a workflow appeared — this test and the
    // migration's claim are now stale." `PROTOTYPE_BUILD`
    // (docs/phase-4-implementation-traceability.md P4-PROTO-AGENT-DEF) is
    // that workflow. The migration's own prose is quoted below rather than
    // edited — "it changes no behaviour" was true on 2026-09-14 and is not a
    // claim about every day after it.
    const keys = new Set([...WORKFLOWS.matchAll(/agentKey: '([a-z_]+)'/g)].map((m) => m[1]));
    assert.equal(keys.has('ui_prototype'), true, 'ui_prototype should have a workflow by now — PROTOTYPE_BUILD went missing');
    // The eight that already had one before this migration still do; enabling
    // ui_prototype in 20260914's migration did not remove any of them.
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

describe('C. the inversion the levels carried, and no longer do', () => {
  test('L1 and L2 permit the same work — the ordering is honest now (G-247)', () => {
    // This test used to assert the OPPOSITE and to say so: it failed the day
    // the inversion was fixed, on purpose, so the record could not drift away
    // from the code quietly. This is that day, and the migration that warned
    // about it is quoted below rather than edited — it was true when written.
    for (const work of ['read', 'draft', 'internal_plan', 'breakdown', 'client_direct']) {
      assert.equal(mayAgentRun('L1', work).allowed, true, `L1 refused ${work}`);
      assert.equal(mayAgentRun('L2', work).allowed, true, `L2 refused ${work}`);
    }
    for (const work of ['client_facing', 'money', 'delivery_approval']) {
      assert.equal(mayAgentRun('L1', work).allowed, false, `L1 permitted ${work}`);
      assert.equal(mayAgentRun('L2', work).allowed, false, `L2 permitted ${work}`);
    }
  });

  test('so moving an agent between them widens nothing', () => {
    for (const work of ['read', 'draft', 'internal_plan', 'breakdown', 'client_direct', 'client_facing', 'money', 'delivery_approval']) {
      assert.equal(
        mayAgentRun('L1', work).allowed,
        mayAgentRun('L2', work).allowed,
        `${work} is still permitted at one level and not the other`,
      );
    }
    // The migration's warning stays in the migration: it described the code as
    // it was, and rewriting history to match the present is how a record stops
    // being one.
    assert.match(PROSE, /L1 is therefore the MORE permissive level/);
    assert.match(PROSE, /G-247/);
  });

  test('and the two paths the owner granted by name still run', () => {
    // ADM-11 §4 and ADM-91. Refusing `client_facing` at L1 would have stopped
    // both — and moving their agent to L2 would not have helped, because L2
    // refuses it too. NO LEVEL would have permitted them, so the exception is
    // a work CLASS: the permission belongs to the path.
    for (const kind of ['followup.compose', 'reply.compose']) {
      const at = WORKFLOWS.indexOf(`jobKind: '${kind}'`);
      assert.ok(at > 0, `${kind} is gone`);
      assert.match(WORKFLOWS.slice(at, at + 2000), /workClass: 'client_direct'/, `${kind} changed work class`);
    }
    assert.equal(mayAgentRun('L1', 'client_direct').allowed, true);
    assert.match(PROSE, /reach the client unread, by ADM-11 and ADM-91/);
  });
});
