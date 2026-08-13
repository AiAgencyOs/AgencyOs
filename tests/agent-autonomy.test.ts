import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { AUTONOMY_LEVELS, mayAgentRun } from '../src/lib/ai/autonomy.ts';

/**
 * Agent autonomy — gap G-041.
 *
 * `ai.agents.autonomy_level` has existed since the schema was written and the
 * runner selected it and threw it away, so the column described a capability
 * the code did not have. Turning an agent down was a deploy.
 *
 * The rule is pure, so it is tested directly. That it is *enforced* twice —
 * once in the runner for the message, once in Postgres so nothing can skip it
 * — is pinned structurally, because the second half has no caller a unit test
 * can reach.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260813120009_agent_autonomy.sql');
const route = read('../app/api/jobs/run/route.ts');
const schema = read('../supabase/migrations/20260807120008_ai.sql');

describe('A. the levels are the ones the schema documents', () => {
  test('L0, L1, L2 — the same three, in the same words', () => {
    assert.deepEqual([...AUTONOMY_LEVELS], ['L0', 'L1', 'L2']);
    assert.match(schema, /autonomy_level\s+text not null default 'L1' check \(autonomy_level in \('L0', 'L1', 'L2'\)\)/);
  });
});

describe('B. what each level may do', () => {
  test('L1 proposes, and may act', () => {
    assert.deepEqual(mayAgentRun('L1'), { allowed: true });
  });

  test('L0 is read-only and is refused', () => {
    const verdict = mayAgentRun('L0');
    assert.equal(verdict.allowed, false);
    assert.match(verdict.allowed === false ? verdict.reason : '', /read-only/);
  });

  test('L2 is refused rather than silently treated as L1', () => {
    // An operator who sets L2 expecting autonomy and gets L1 with no word
    // said is worse off than one who is refused: the first believes something
    // untrue about their own deployment.
    const verdict = mayAgentRun('L2');
    assert.equal(verdict.allowed, false);
    assert.match(verdict.allowed === false ? verdict.reason : '', /G-101/);
  });

  test('an unrecognised level is refused, not defaulted', () => {
    for (const junk of ['', 'l1', 'L3', 'yes']) {
      assert.equal(mayAgentRun(junk).allowed, false, `${junk} was allowed to act`);
    }
  });
});

describe('C. it is enforced where it cannot be skipped', () => {
  test('the runner checks before doing any work', () => {
    assert.match(route, /const autonomy = mayAgentRun\(agent\.autonomy_level\)/);
    // Compared against the call site, not the bare name: `resolveProvider`
    // also appears in the import list on line 3, which made an earlier
    // version of this assertion pass for the wrong reason.
    assert.ok(
      route.indexOf('mayAgentRun(agent.autonomy_level)') <
        route.indexOf('resolveProvider(agent.default_model)'),
      'the model must not be reached by an agent that may not act',
    );
  });

  test('and the database refuses the same thing independently', () => {
    // D16's rule: the database refuses what the application refuses. A second
    // caller — a script, a future worker — does not get to skip the check by
    // not knowing about it.
    assert.match(migration, /create trigger agent_runs_autonomy_guard[\s\S]*?before insert on ai\.agent_runs/);
    assert.match(migration, /if v_level <> 'L1' then/);
  });

  test('the guard also refuses a disabled or unregistered agent', () => {
    assert.match(migration, /is disabled/);
    assert.match(migration, /is not registered/);
  });
});
