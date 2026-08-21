import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { AUTONOMY_LEVELS, WORK_CLASSES, mayAgentRun } from '../src/lib/ai/autonomy.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

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
const route = RUNNER_SOURCE;
const schema = read('../supabase/migrations/20260807120008_ai.sql');

describe('A. the levels are the ones the schema documents', () => {
  test('L0, L1, L2 — the same three, in the same words', () => {
    assert.deepEqual([...AUTONOMY_LEVELS], ['L0', 'L1', 'L2']);
    assert.match(schema, /autonomy_level\s+text not null default 'L1' check \(autonomy_level in \('L0', 'L1', 'L2'\)\)/);
  });
});

describe('B. what each level may do, and to which work', () => {
  const ALONE = ['read', 'draft', 'internal_plan', 'breakdown'] as const;   // ADM-61 §2
  const MUST_ASK = ['client_facing', 'money', 'delivery_approval'] as const; // ADM-61 §3

  test('the classes are §2 and §3, and nothing else', () => {
    // Both lists come straight out of
    // docs/business-os/08-ai-agent-responsibilities.md. A class invented here
    // would be an autonomy rule invented here.
    assert.deepEqual([...WORK_CLASSES], [...ALONE, ...MUST_ASK]);
  });

  test('L1 proposes, and may act on any of it', () => {
    // Unchanged, and deliberately: everything AgencyOS runs today is L1, so
    // teaching the gate about work classes had to leave L1 exactly as it was.
    for (const work of WORK_CLASSES) {
      assert.deepEqual(mayAgentRun('L1', work), { allowed: true }, `L1 was refused ${work}`);
    }
  });

  test('L0 is read-only and is refused, whatever the work', () => {
    for (const work of WORK_CLASSES) {
      const verdict = mayAgentRun('L0', work);
      assert.equal(verdict.allowed, false, `L0 was allowed ${work}`);
      assert.match(verdict.allowed === false ? verdict.reason : '', /read-only/);
    }
  });

  test('L2 acts alone on §2 work', () => {
    // "Break approved requirements into modules, features and tasks… Plan,
    // schedule, re-order and update internal work. Draft anything at all…
    // Read anything its organization can read."
    for (const work of ALONE) {
      assert.deepEqual(mayAgentRun('L2', work), { allowed: true }, `L2 was refused ${work}`);
    }
  });

  test('and asks for §3 work, with the clause that refuses it', () => {
    // "Anything that reaches a client… Anything touching money… Delivery
    // approvals: UI designs, prototypes, builds, QA and production-ready
    // sign-off."
    for (const work of MUST_ASK) {
      const verdict = mayAgentRun('L2', work);
      assert.equal(verdict.allowed, false, `L2 was allowed ${work} alone`);
      const reason = verdict.allowed === false ? verdict.reason : '';
      assert.match(reason, /ADM-61/, `${work} is refused without citing the policy`);
      assert.match(reason, /internal group/, `${work} does not say where it must go`);
      assert.ok(
        !/no defined behaviour|needs a stated policy|no such policy/i.test(reason),
        'the refusal still claims no policy exists',
      );
    }
  });

  test('drafting is permitted at L2 — and accepting the draft is not this gate’s job', () => {
    // The old gate refused every L2 agent with an argument about ONE path:
    // requirement extraction, where autonomy would mean the agent accepting
    // its own proposal. That argument was right about extraction and was
    // never right about the other six L2 agents, which the gate could not
    // tell apart.
    //
    // What stops an agent accepting its own proposal is three things, none of
    // them a level: `decideRequirementVersion` calls `requireInternal()` and
    // checks `lead.write`, so it needs a signed-in person; no tool in the
    // registry names it; and no workflow writes `accepted`. A gate is the
    // wrong place to hold a rule that three other layers already hold.
    assert.deepEqual(mayAgentRun('L2', 'draft'), { allowed: true });

    const service = read('../src/modules/crm/service.ts');
    const at = service.indexOf('export async function decideRequirementVersion');
    const body = service.slice(at, at + 500);
    assert.match(body, /requireInternal\(\)/);
    assert.match(body, /can\(context\.role, 'lead\.write'\)/);

    const tools = read('../src/modules/agents/tools.ts');
    assert.doesNotMatch(tools, /decideRequirement/);
  });

  test('an unrecognised level is refused, not defaulted', () => {
    for (const junk of ['', 'l1', 'L3', 'yes']) {
      for (const work of WORK_CLASSES) {
        assert.equal(mayAgentRun(junk, work).allowed, false, `${junk} was allowed ${work}`);
      }
    }
  });

  test('and an unrecognised work class is refused at every level', () => {
    // A caller that forgets the class, or mistypes it, must not be treated as
    // having declared the safest one — for the same reason a typo'd level is
    // not treated as L0.
    for (const level of ['L0', 'L1', 'L2']) {
      for (const junk of ['', 'Draft', 'internal', 'anything']) {
        const verdict = mayAgentRun(level, junk);
        assert.equal(verdict.allowed, false, `${level} was allowed work "${junk}"`);
        assert.match(verdict.allowed === false ? verdict.reason : '', /not recognised/);
      }
    }
  });
});

describe('C. it is enforced where it cannot be skipped', () => {
  test('the runner checks before doing any work', () => {
    assert.match(route, /const autonomy = mayAgentRun\(agent\.autonomy_level, workflow\.workClass\)/);
    // Compared against the call site, not the bare name: `resolveProvider`
    // also appears in the import list on line 3, which made an earlier
    // version of this assertion pass for the wrong reason.
    assert.ok(
      route.indexOf('mayAgentRun(agent.autonomy_level, workflow.workClass)') <
        route.indexOf('resolveProvider(ctx.agent.default_model)'),
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
