import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WORK_CLASSES, mayAgentRun } from '../src/lib/ai/autonomy.ts';
import { region } from './_region.ts';

/**
 * The level is a level again — G-247.
 *
 * `mayAgentRun` and `ai.agent_runs_autonomy_guard` permitted **every** work
 * class at L1 and only ADM-61 §2's four at L2, so the gate was **stricter at
 * the higher level**. The column is presented to an owner as an autonomy
 * LEVEL, ordered L0 < L1 < L2, so an owner moving an agent down from L2 to L1
 * to restrain it **widened what it may run** — and one such move had already
 * been made and recorded as a widening.
 *
 * The owner chose: **L1 stops permitting the three.**
 *
 * ── the correction that shaped the fix ────────────────────────────────
 *
 * The first plan was that the two client-facing workflows would move to L2.
 * **That is wrong**: L2 refuses `client_facing` as well, so no level would
 * have permitted them, and `followup.compose` and `reply.compose` are
 * permitted by the owner's own ADM-11 §4 and ADM-91.
 *
 * So the exception is a work CLASS — `client_direct` — because the permission
 * belongs to the **path** a decision names, not to the agent's autonomy.
 *
 * **Both layers move together.** A rule held by two layers and tested through
 * one is half a check: the migration is asserted here as well as the pure
 * function, and the live script exercises the database's own refusal in CI.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260920120000_the_level_is_a_level_again.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const AUTONOMY = read('src/lib/ai/autonomy.ts');
const SCRIPT = read('scripts/verify-agent-autonomy.mjs');
const guard = region(SQL, 'CREATE OR REPLACE FUNCTION ai.agent_runs_autonomy_guard', '$function$;');

describe('A. the two layers say the same thing', () => {
  test('the database applies one list to L1 and L2', () => {
    assert.match(guard, /if v_level in \('L1', 'L2'\) then/);
    assert.match(
      guard,
      /if new\.work_class in \('read', 'draft', 'internal_plan', 'breakdown', 'client_direct'\) then/,
    );
  });

  test('and the pure function applies the same one', () => {
    assert.match(
      AUTONOMY,
      /const ALONE: readonly string\[\] = \['read', 'draft', 'internal_plan', 'breakdown', 'client_direct'\];/,
    );
    assert.match(AUTONOMY, /if \(level === 'L1' \|\| level === 'L2'\) \{/);
  });

  test('the two lists are identical, element for element', () => {
    // Not "both mention client_direct": the whole defect was two layers that
    // each looked right and disagreed about a level.
    const sqlList = /in \('read', 'draft', 'internal_plan', 'breakdown', 'client_direct'\)/.exec(guard);
    const tsList = /const ALONE: readonly string\[\] = \[([^\]]*)\]/.exec(AUTONOMY);
    assert.ok(sqlList && tsList, 'one of the two lists could not be read');
    const ts = tsList![1]!.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    assert.deepEqual(ts, ['read', 'draft', 'internal_plan', 'breakdown', 'client_direct']);
  });

  test('and the column’s CHECK admits the class the guard permits', () => {
    // A guard permitting a value the column refuses reads as a working gate
    // and fails on the first run.
    assert.match(SQL, /'client_direct', 'client_facing', 'money', 'delivery_approval'/);
    assert.match(SQL, /add constraint agent_runs_work_class_check/);
  });
});

describe('B. what it refuses that it did not refuse yesterday', () => {
  test('§3’s three classes are refused at BOTH levels now', () => {
    for (const level of ['L1', 'L2']) {
      for (const work of ['client_facing', 'money', 'delivery_approval']) {
        const verdict = mayAgentRun(level, work);
        assert.equal(verdict.allowed, false, `${level} permitted ${work}`);
        assert.match(verdict.allowed === false ? verdict.reason : '', /internal group/);
      }
    }
  });

  test('and the refusal names the level it came from', () => {
    // "agent is L1, and it reaches a client…" — an operator reading a refused
    // run should not have to work out which rule refused it.
    const refused = mayAgentRun('L1', 'money');
    assert.match(refused.allowed === false ? refused.reason : '', /agent is L1/);
    assert.match(guard, /'agent "%" is % and "%" must come to the internal group first \(ADM-61 §3\)'/);
  });

  test('nothing that runs today is refused, and the file says which', () => {
    const declared = [...read('app/api/jobs/run/workflows.ts').matchAll(/workClass: '(\w+)'/g)].map((m) => m[1]);
    for (const forbidden of ['client_facing', 'money', 'delivery_approval']) {
      assert.equal(declared.includes(forbidden), false, `a workflow still declares ${forbidden}`);
    }
    assert.match(PROSE, /Nothing runs those today/);
  });
});

describe('C. the exception is a path, not a level', () => {
  test('`client_direct` is permitted at L1 and L2 and refused at L0', () => {
    assert.equal(mayAgentRun('L1', 'client_direct').allowed, true);
    assert.equal(mayAgentRun('L2', 'client_direct').allowed, true);
    assert.equal(mayAgentRun('L0', 'client_direct').allowed, false);
  });

  test('and it is the ONLY client-facing class any level permits', () => {
    const clientish = WORK_CLASSES.filter((c) => c.startsWith('client_'));
    assert.deepEqual([...clientish], ['client_direct', 'client_facing']);
    assert.equal(mayAgentRun('L2', 'client_facing').allowed, false);
  });

  test('the decisions that grant it are named where it is defined', () => {
    assert.match(AUTONOMY, /ADM-61 §4 records the ADM-11\s*\n \* follow-ups as \*"the only path in AgencyOS where something reaches a client\s*\n \* unread"\*/);
    assert.match(AUTONOMY, /ai agent khud kare/);
  });

  test('and the migration records why moving the agents would not have worked', () => {
    assert.match(PROSE, /while moving their agent to L2 does not help, because L2 refuses it too/);
    assert.match(PROSE, /\*\*No level would have permitted them\*\*/);
  });
});

describe('D. the consequence is stated, not left to be found', () => {
  test('L1 and L2 now permit exactly the same work, and the file says so', () => {
    for (const work of WORK_CLASSES) {
      assert.equal(
        mayAgentRun('L1', work).allowed,
        mayAgentRun('L2', work).allowed,
        `${work} differs between the levels`,
      );
    }
    assert.match(PROSE, /at this gate L1 and\s+L2 permit exactly the same work/);
  });

  test('and what the level still decides is said too', () => {
    assert.match(PROSE, /What the level still\s+decides here is L0 against the rest/);
  });

  test('the registry comment that advertised the inversion is replaced', () => {
    // A stale comment on the table an owner reads is worse than none.
    assert.match(SQL, /comment on table ai\.agents is/);
    assert.match(SQL, /G-247 is closed: L1 and L2 now permit the SAME work/);
  });

  test('and the guard body was generated from the live definition', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION ai\.agent_runs_autonomy_guard/);
    assert.match(PROSE, /the lesson of G-303/);
  });
});

describe('E. the database’s own refusal is exercised, not assumed', () => {
  test('the live script drives L1 against the three', () => {
    assert.match(SCRIPT, /an L1 agent brings \$\{work\} to the internal group too — ADM-61 §3/);
  });

  test('and proves the exception is accepted rather than merely declared', () => {
    assert.match(SCRIPT, /and client_direct is permitted — ADM-61 §4, ADM-11 and ADM-91/);
  });

  test('at both levels, because a rule held by two layers must be driven at both', () => {
    assert.match(SCRIPT, /for \(const work of \['read', 'draft', 'internal_plan', 'breakdown', 'client_direct'\]\)/);
  });

  test('and every live script that names the class followed it', () => {
    // CI found these, not the unit suite: `verify-flow-01` reads the sales
    // agent's run BY work class, so reclassifying the workflow and leaving the
    // script alone turned a passing end-to-end flow into four red checks. The
    // rule moved and its readers move with it.
    for (const rel of ['scripts/verify-flow-01.mjs', 'scripts/verify-agent-dispatch.mjs']) {
      const script = read(rel);
      assert.doesNotMatch(script, /work_class=eq\.client_facing/, `${rel} still reads the old class`);
      assert.doesNotMatch(script, /'client_facing', 'money', 'delivery_approval'\]\.\s*$/m, rel);
    }
    assert.match(read('scripts/verify-flow-01.mjs'), /work_class=eq\.client_direct/);
  });
});
