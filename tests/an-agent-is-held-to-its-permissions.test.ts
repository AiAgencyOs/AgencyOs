import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { decideProjectAction, decideToolCall, projectIdOf, REFUSAL_KINDS } from '../src/lib/ai/policy-decision.ts';
import { sqlCode } from './_code-only.ts';
import { region } from './_region.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * An agent is held to its permissions — the owner's decision 3 of 2026-09-29.
 *
 * `ai.agent_tool_permissions` and `ai.agent_project_assignments` were built
 * (20260929170000) as "a policy record the orchestrator does not yet read".
 * The owner decided the runner reads them: a denied tool is refused at call
 * time and logged, and an agent with any assignment runs only on those
 * projects (none = all).
 *
 * The decision is pure (`policy-decision.ts`) and tested by calling it. That
 * it is ENFORCED — the runner reaches `dispatchTool` only through the policy
 * wrapper, `openRun` asks the assignment, a refusal is a row and an audit
 * entry — is pinned structurally, because the runner holds a service-role
 * client a unit test has no business holding.
 */

const migration = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => f.includes('the_runner_holds_an_agent_to_its_policy'))
  .map((f) => read(`supabase/migrations/${f}`))
  .join('\n');

describe('A. the tool rule — deny by default, and denied means denied', () => {
  test('no recorded row is a refusal, not a default', () => {
    const verdict = decideToolCall({ agentKey: 'sales', toolKey: 'memory.recall', permission: null });
    assert.equal(verdict.allowed, false);
    assert.equal(!verdict.allowed && verdict.kind, 'tool_unrecorded');
    assert.match(!verdict.allowed ? verdict.reason : '', /no permission recorded/);
  });

  test('a row with allowed = false refuses, and says the owner denied it', () => {
    const verdict = decideToolCall({ agentKey: 'sales', toolKey: 'memory.recall', permission: { allowed: false } });
    assert.equal(verdict.allowed, false);
    assert.equal(!verdict.allowed && verdict.kind, 'tool_denied');
  });

  test('only a row with allowed = true lets the call through', () => {
    assert.deepEqual(decideToolCall({ agentKey: 'sales', toolKey: 'memory.recall', permission: { allowed: true } }), { allowed: true });
  });
});

describe('B. the project rule — any assignment narrows, none means all', () => {
  test('an agent with no assignment may work on any project', () => {
    assert.deepEqual(decideProjectAction({ agentKey: 'project_manager', projectId: 'p-1', assignedProjectIds: [] }), { allowed: true });
  });

  test('an agent assigned somewhere may work there', () => {
    assert.deepEqual(decideProjectAction({ agentKey: 'project_manager', projectId: 'p-1', assignedProjectIds: ['p-1', 'p-2'] }), { allowed: true });
  });

  test('and nowhere else', () => {
    const verdict = decideProjectAction({ agentKey: 'project_manager', projectId: 'p-3', assignedProjectIds: ['p-1', 'p-2'] });
    assert.equal(verdict.allowed, false);
    assert.equal(!verdict.allowed && verdict.kind, 'project_unassigned');
    assert.match(!verdict.allowed ? verdict.reason : '', /2 projects/);
  });

  test('the project is read from the one key every workflow and tool uses', () => {
    assert.equal(projectIdOf({ projectId: 'p-1', other: 1 }), 'p-1');
    assert.equal(projectIdOf({ projectId: '' }), null);
    assert.equal(projectIdOf({ leadId: 'l-1' }), null);
    assert.equal(projectIdOf('p-1'), null);
    assert.equal(projectIdOf(null), null);
  });
});

describe('C. the runner enforces it — structurally', () => {
  const enforcement = read('src/modules/agents/policy-enforcement.ts');
  const agentRun = read('app/api/jobs/run/agent-run.ts');
  const workflows = read('app/api/jobs/run/workflows.ts');
  const route = read('app/api/jobs/run/route.ts');

  test('no workflow calls dispatchTool directly; every call goes through the policy wrapper', () => {
    const code = workflows.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(code, /\bdispatchTool\(/, 'a workflow reaches dispatchTool without asking the policy');
    assert.match(code, /dispatchToolUnderPolicy\(\{/);
    assert.match(enforcement, /refuseToolCallIfUnpermitted\(/);
    assert.match(enforcement, /if \(!verdict\.allowed\) return err\('FORBIDDEN', verdict\.reason\);/);
    // The policy is asked BEFORE dispatchTool, never after.
    assert.ok(enforcement.indexOf('refuseToolCallIfUnpermitted(') < enforcement.indexOf('return dispatchTool({'));
  });

  test('openRun asks the assignment before a run is opened on a project, and stops the workflow by throwing', () => {
    assert.match(agentRun, /const projectId = projectIdOf\(subject\.input\);/);
    assert.match(agentRun, /decideProjectAction\(\{/);
    assert.match(agentRun, /throw new AgentPolicyRefusal\(/);
    assert.match(agentRun, /recordAgentPolicyRefusal\(ctx\.admin/);
    // The refusal is a run row too, so the Failures list shows it.
    assert.match(agentRun, /status: verdict\.allowed \? 'running' : 'failed'/);
  });

  test('route.ts catches exactly that refusal and parks the job rather than retrying the same answer', () => {
    assert.match(route, /if \(!\(error instanceof AgentPolicyRefusal\)\) throw error;/);
    assert.match(route, /await parkRefusedJob\(admin, job, error\);/);
    assert.match(agentRun, /status: 'dead', last_error: `refused by agent policy/);
  });

  test('the gate order is unchanged: the registry kill switch and autonomy still run before any workflow', () => {
    const killSwitch = RUNNER_SOURCE.indexOf('if (!agent.enabled)');
    const autonomy = RUNNER_SOURCE.indexOf('mayAgentRun(agent.autonomy_level');
    const work = RUNNER_SOURCE.indexOf('await workflow.run({');
    assert.ok(killSwitch > -1 && autonomy > killSwitch && work > autonomy);
  });

  test('the platform layer never imports the module layer for this', () => {
    for (const f of ['src/lib/ai/policy-decision.ts', 'src/lib/ai/agent-policy.ts']) {
      assert.doesNotMatch(read(f), /from '@\/modules\//, `${f} reaches into modules/`);
    }
  });
});

describe('D. a refusal is a record, and the record is audited', () => {
  test('the migration exists and creates the refusal table with the three kinds', () => {
    assert.ok(migration, 'the migration is missing');
    assert.match(migration, /create table if not exists ai\.agent_policy_refusals/);
    for (const kind of REFUSAL_KINDS) assert.match(migration, new RegExp(`'${kind}'`));
    assert.deepEqual([...REFUSAL_KINDS], ['tool_denied', 'tool_unrecorded', 'project_unassigned']);
  });

  test('RLS is on and forced, staff may read, and only the service role may write', () => {
    const code = sqlCode(migration);
    assert.match(code, /alter table ai\.agent_policy_refusals enable row level security/);
    assert.match(code, /alter table ai\.agent_policy_refusals force row level security/);
    assert.match(code, /create policy agent_policy_refusals_select on ai\.agent_policy_refusals[\s\S]*?core\.is_internal\(\)/);
    assert.doesNotMatch(code, /create policy agent_policy_refusals_(write|insert|update)/);
    assert.match(code, /grant select on ai\.agent_policy_refusals to authenticated;/);
    assert.match(code, /grant select, insert on ai\.agent_policy_refusals to service_role;/);
  });

  test('tenancy is held by trigger for both parent rows', () => {
    const code = sqlCode(migration);
    assert.match(code, /core\.enforce_parent_org\('run_id', 'ai\.agent_runs'\)/);
    assert.match(code, /core\.enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(code, /freeze_org_agent_policy_refusals[\s\S]*?core\.freeze_organization_id\(\)/);
  });

  test('the one door writes the row and the audit entry in the same transaction, and only the runner may call it', () => {
    const body = region(migration, 'create or replace function ai.record_agent_policy_refusal');
    assert.match(body, /insert into ai\.agent_policy_refusals/);
    assert.match(body, /perform core\.record_audit\([\s\S]*?'agent\.policy_refused'/);
    assert.match(migration, /revoke all on function ai\.record_agent_policy_refusal\([^)]*\) from public, anon, authenticated;/);
    assert.match(migration, /grant execute on function ai\.record_agent_policy_refusal\([^)]*\) to service_role;/);
    const policy = read('src/lib/ai/agent-policy.ts');
    assert.match(policy, /rpc\('record_agent_policy_refusal'/);
  });

  test('the page lists them, and the policy tables no longer call themselves unread', () => {
    const page = read('app/(internal)/agents/[agentKey]/page.tsx');
    assert.match(page, /listAgentPolicyRefusals\(agentKey\)/);
    assert.match(page, /title="Refusals"/);
    assert.doesNotMatch(page, /not yet enforcement/);
    assert.match(migration, /comment on table ai\.agent_tool_permissions is[\s\S]*?Read by the runner/);
    assert.match(migration, /comment on table ai\.agent_project_assignments is[\s\S]*?Read by the runner/);
  });
});
