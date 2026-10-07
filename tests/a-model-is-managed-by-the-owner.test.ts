import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { orderModelCandidates } from '../src/lib/ai/model-choice.ts';
import { providerOfModel } from '../src/lib/ai/model-provider.ts';
import { mayReplay, SAFE_WORK_CLASSES } from '../src/lib/ai/replay-rules.ts';
import { withinBudget } from '../src/lib/ai/run-gates.ts';
import { codeOnly, sqlCode } from './_code-only.ts';
import { region } from './_region.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * A model is managed by the owner — decision 2026-09-30: ADM-84 reversed.
 *
 *   A. the fallback chain sits after the override and the policy and before
 *      the default — the pure rule, proved rather than trusted
 *   B. a budget is a cap the runner refuses past, a replay is for read-only
 *      work only, a provider is named by the adapters' own rule — pure
 *   C. the migration holds the doors (owner, audited), drops the plain write
 *      policy, and gives the runner what it needs: the switches in the claim
 *      and send functions, the work-class column, the refusal kind
 *   D. the runner asks — gates before the model call, the catch in the tick,
 *      the work-class gate beside autonomy — structurally
 *   E. the send callers honour the outbound switch, every one of them
 */

describe('A. the fallback chain is consulted after the override and the policy, before the default', () => {
  test('order: agent override, policy override, policy preference, fallback chain, agent default', () => {
    const candidates = orderModelCandidates({
      override: { preferredModels: ['claude-override'] },
      policy: { adminOverrideModel: 'gpt-policy-override', preferredModels: ['gemini-policy-pref'] },
      fallbackChain: ['grok-fallback-1', 'openai/fallback-2'],
      agentDefault: 'claude-default',
    });
    assert.deepEqual(
      candidates.map((c) => [c.model, c.source]),
      [
        ['claude-override', 'agent_override'],
        ['gpt-policy-override', 'policy_override'],
        ['gemini-policy-pref', 'policy_preference'],
        ['grok-fallback-1', 'fallback_chain'],
        ['openai/fallback-2', 'fallback_chain'],
        ['claude-default', 'agent_default'],
      ],
    );
  });

  test('a model the policy already named keeps its earlier credit; no chain means exactly the old order', () => {
    const dup = orderModelCandidates({ override: null, policy: { adminOverrideModel: null, preferredModels: ['claude-a'] }, fallbackChain: ['claude-a', 'claude-b'], agentDefault: 'claude-d' });
    assert.deepEqual(dup.map((c) => c.source), ['policy_preference', 'fallback_chain', 'agent_default']);
    const none = orderModelCandidates({ override: null, policy: null, agentDefault: 'claude-d' });
    assert.deepEqual(none.map((c) => [c.model, c.source]), [['claude-d', 'agent_default']]);
  });
});

describe('B. the budget, the replay rule and the provider name are pure', () => {
  test('a cap is refused at the cap, not past it; no cap is no refusal', () => {
    assert.equal(withinBudget(null, 10_000), true);
    assert.equal(withinBudget(1_000, 999), true);
    assert.equal(withinBudget(1_000, 1_000), false);
    assert.equal(withinBudget(1_000, 5_000), false);
  });

  test('only read-only work replays', () => {
    assert.deepEqual([...SAFE_WORK_CLASSES], ['read']);
    assert.equal(mayReplay('read'), true);
    for (const w of ['draft', 'internal_plan', 'breakdown', 'client_direct', 'client_facing', 'money', 'delivery_approval', null, undefined]) {
      assert.equal(mayReplay(w), false, String(w));
    }
  });

  test('the provider is named by the adapters’ own rules, OpenRouter last', () => {
    assert.equal(providerOfModel('claude-sonnet-5'), 'anthropic');
    assert.equal(providerOfModel('gpt-5-mini'), 'openai');
    assert.equal(providerOfModel('o3'), 'openai');
    assert.equal(providerOfModel('gemini-2.5-flash'), 'gemini');
    assert.equal(providerOfModel('grok-4'), 'xai');
    assert.equal(providerOfModel('openai/gpt-5-mini'), 'openrouter');
    assert.equal(providerOfModel('something-else'), null);
    assert.equal(providerOfModel(null), null);
  });
});

const migration = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => f.includes('a_model_is_managed_a_role_is_honoured'))
  .map((f) => read(`supabase/migrations/${f}`))
  .join('\n');

describe('C. the migration: the doors, the tables, and what the runner needs', () => {
  const code = sqlCode(migration);

  test('states the decision, and drops the plain write policy so the doors are the only path', () => {
    assert.match(migration, /Decision 2026-09-30: ADM-84 reversed — the owner manages models in the panel/);
    assert.match(code, /drop policy if exists models_write on ai\.models;/);
    assert.doesNotMatch(code, /create policy models_write/);
  });

  for (const [fn, action] of [
    ['ai.add_model', 'model.added'],
    ['ai.retire_model', 'model.retired'],
    ['ai.set_fallback_chain', 'fallback_chain.set'],
    ['ai.set_provider_budget', 'provider_budget.set'],
    ['ai.set_agent_work_classes', 'agent.work_classes_set'],
  ] as const) {
    test(`${fn} is SECURITY DEFINER, owner-gated and audits ${action}`, () => {
      const body = region(code, `create or replace function ${fn}(`, '$$;');
      assert.match(body, /security definer/);
      assert.match(body, /if not coalesce\(\(select core\.is_owner\(\)\), false\) then/);
      assert.match(body, new RegExp(`core\\.record_audit\\([\\s\\S]*?'${action.replace('.', '\\.')}'`));
    });
  }

  test('a retired model cannot be one a chain still names, and a chain names only registered, available models', () => {
    assert.match(region(code, 'create or replace function ai.retire_model(', '$$;'), /'in_a_chain'::text/);
    const chain = region(code, 'create or replace function ai.set_fallback_chain(', '$$;');
    assert.match(chain, /m\.status = 'available'/);
    assert.match(chain, /'unknown_model'::text/);
  });

  for (const table of ['ai.fallback_chains', 'ai.provider_budgets']) {
    test(`${table} carries the tenancy discipline: RLS enabled and forced, internal select, frozen organisation, no plain write policy`, () => {
      const t = table.split('.')[1] as string;
      assert.match(code, new RegExp(`create table if not exists ${table.replace('.', '\\.')} \\(`));
      assert.match(code, new RegExp(`alter table ${table.replace('.', '\\.')} enable row level security;`));
      assert.match(code, new RegExp(`alter table ${table.replace('.', '\\.')} force row level security;`));
      assert.match(code, new RegExp(`create policy ${t}_select on ${table.replace('.', '\\.')}[\\s\\S]*?core\\.is_internal\\(\\)`));
      assert.doesNotMatch(code, new RegExp(`create policy ${t}_(write|insert|update|delete)`));
      assert.match(code, new RegExp(`create trigger freeze_org_${t}[\\s\\S]*?core\\.freeze_organization_id\\(\\)`));
    });
  }

  test('the spend is measured from the steps the runtime wrote, this calendar month, never estimated', () => {
    const spend = region(code, 'create or replace function ai.provider_spend_this_month(', '$$;');
    assert.match(spend, /from ai\.agent_steps s/);
    assert.match(spend, /s\.request ->> 'provider' = p_provider/);
    assert.match(spend, /date_trunc\('month', now\(\)\)/);
  });

  test('a budget refusal is recorded like a policy refusal — one more kind on the same table', () => {
    assert.match(code, /check \(kind in \('tool_denied', 'tool_unrecorded', 'project_unassigned', 'provider_budget_exceeded'\)\)/);
    assert.match(code, /or \(kind = 'provider_budget_exceeded'\)/);
  });

  test('allowed_work_classes is a column of the registry, constrained to ADM-61’s eight, empty by default', () => {
    assert.match(code, /add column if not exists allowed_work_classes text\[\] not null default '\{\}'::text\[\]/);
    assert.match(code, /agents_allowed_work_classes_check/);
  });

  test('the claims and the send chokepoint honour the switches', () => {
    const agentClaim = region(code, 'CREATE OR REPLACE FUNCTION core.claim_agent_job(', '$function$;');
    assert.match(agentClaim, /not core\.org_paused\(organization_id, 'agents_paused'\)/);
    assert.match(agentClaim, /not core\.org_paused\(organization_id, 'jobs_paused'\)/);
    const claim = region(code, 'CREATE OR REPLACE FUNCTION core.claim_jobs(', '$function$;');
    assert.match(claim, /not core\.org_paused\(organization_id, 'jobs_paused'\)/);
    const send = region(code, 'CREATE OR REPLACE FUNCTION crm.send_outbound_message(', '$function$;');
    assert.match(send, /if core\.org_paused\(v_conversation\.organization_id, 'outbound_paused'\) then\s*return query select 'outbound_paused'::text/);
    // Checked BEFORE consent and BEFORE the idempotency lookup, so a paused
    // send cannot become a sent one by being retried.
    assert.ok(send.indexOf("'outbound_paused'::text") < send.indexOf('crm.communication_consent'));
    assert.ok(send.indexOf("'outbound_paused'::text") < send.indexOf('m.external_ref    = p_external_ref'));
  });

  test('replay_run is admin-gated and refuses every class but read', () => {
    const body = region(code, 'create or replace function ai.replay_run(', '$$;');
    assert.match(body, /if not coalesce\(\(select core\.is_admin\(\)\), false\) then/);
    assert.match(body, /if v_run\.work_class is distinct from 'read' then\s*return query select 'unsafe_work_class'::text/);
    assert.match(body, /'agent_run\.replayed'/);
  });

  test('cancel_running_job stamps a flag; settle_cancelled_job is the runner’s alone and audits job.cancelled', () => {
    const ask = region(code, 'create or replace function core.cancel_running_job(', '$$;');
    assert.match(ask, /set cancel_requested_at = now\(\)/);
    assert.match(ask, /'job\.cancel_requested'/);
    assert.match(ask, /if v_status <> 'running' then/);
    assert.match(code, /revoke all on function core\.settle_cancelled_job\(uuid, uuid\) from public, anon, authenticated;/);
    assert.match(code, /grant execute on function core\.settle_cancelled_job\(uuid, uuid\) to service_role;/);
    assert.match(region(code, 'create or replace function core.settle_cancelled_job(', '$$;'), /'job\.cancelled'/);
  });
});

describe('D. the runner asks — structurally', () => {
  const agentRun = codeOnly(read('app/api/jobs/run/agent-run.ts'));
  const route = codeOnly(read('app/api/jobs/run/route.ts'));

  test('the routed model is asked with the work class, so the chain for that class is consulted', () => {
    // One lookup, shared: both model-call sites go through modelPlanFor, which asks it.
    assert.equal((agentRun.match(/routedCandidatesFor\(ctx\.admin, ctx\.job\.organization_id, ctx\.agent\.key, ctx\.workClass\)/g) ?? []).length, 1);
    assert.equal((agentRun.match(/await modelPlanFor\(ctx, \{/g) ?? []).length, 2);
    const routing = codeOnly(read('src/lib/ai/agent-routing.ts'));
    assert.match(routing, /\.from\('fallback_chains'\)/);
    assert.match(routing, /fallbackChain: chainRead\.data\?\.model_ids \?\? \[\]/);
  });

  test('the gates and the budget are asked BEFORE every model call, and between tool rounds', () => {
    const structured = region(agentRun, 'export async function callModel(', 'async function recordToolCall(');
    assert.ok(structured.indexOf('await checkRunGates(') < structured.indexOf('generateStructured('));
    assert.ok(structured.indexOf('await refuseIfOverBudget(') < structured.indexOf('generateStructured('));
    const tools = region(agentRun, 'export async function callModelWithTools(', 'function safeJsonParse');
    const loop = tools.indexOf('for (let round = 0; round < MAX_TOOL_ROUNDS;');
    assert.ok(loop > -1);
    assert.ok(tools.indexOf('await checkRunGates(', loop) > loop && tools.indexOf('await checkRunGates(', loop) < tools.indexOf('generateWithTools(request)'));
    assert.ok(tools.indexOf('await refuseIfOverBudget(', loop) > loop && tools.indexOf('await refuseIfOverBudget(', loop) < tools.indexOf('generateWithTools(request)'));
  });

  test('a budget refusal is recorded through the same door a policy refusal uses, then raised as an alert', () => {
    const gates = codeOnly(read('src/lib/ai/run-gates.ts'));
    const refuse = region(gates, 'export async function refuseIfOverBudget(');
    assert.match(refuse, /rpc\('record_agent_policy_refusal'/);
    assert.match(refuse, /p_kind: 'provider_budget_exceeded'/);
    assert.match(refuse, /await raiseAlert\(admin, \{[\s\S]*?severity: 'critical'/);
    assert.match(refuse, /throw new AgentBudgetRefusal\(/);
    // Fails CLOSED: an unreadable cap is not "no cap".
    assert.match(refuse, /if \(budget\.error\) throw new Error/);
  });

  test('the tick catches the three gates before the policy refusal, each settled its own way', () => {
    const catcher = region(route, '    const outcome = await runPhaseFourWorkflowHop(', 'export async function GET');
    const cancelled = catcher.indexOf('error instanceof JobCancelled');
    const paused = catcher.indexOf('error instanceof AgentsPaused');
    const budget = catcher.indexOf('error instanceof AgentBudgetRefusal');
    const policy = catcher.indexOf('if (!(error instanceof AgentPolicyRefusal)) throw error;');
    assert.ok(cancelled > -1 && paused > cancelled && budget > paused && policy > budget);
    assert.match(catcher, /await settleCancelledJob\(admin, error\);/);
    assert.match(catcher, /await requeuePausedJob\(admin, job, error\);/);
    assert.match(catcher, /await parkBudgetRefusedJob\(admin, job, error\);/);
    assert.match(agentRun, /rpc\('settle_cancelled_job'/);
    assert.match(agentRun, /await finishRun\(admin, refusal\.runId, 'budget_exceeded', refusal\.message\);/);
  });

  test('the work-class gate sits beside autonomy: after the kill switch and mayAgentRun, before the workflow runs; empty means every class', () => {
    const killSwitch = route.indexOf('if (!agent.enabled)');
    const autonomy = route.indexOf('mayAgentRun(agent.autonomy_level');
    const classes = route.indexOf('allowed.length > 0 && !allowed.includes(workflow.workClass)');
    const work = route.indexOf('() => workflow.run({');
    assert.ok(killSwitch > -1 && autonomy > killSwitch && classes > autonomy && work > classes);
    assert.match(route, /select\('key, enabled, default_model, default_effort, autonomy_level, allowed_work_classes'\)/);
  });

  test('a tool call records its arguments and its result, bounded', () => {
    const recorder = region(agentRun, 'async function recordToolCall(');
    assert.match(recorder, /request: \{ tool: args\.toolName, input: boundedJson\(args\.input\) \}/);
    assert.match(recorder, /response: args\.result\.ok \? \{ result: args\.result\.data\.slice\(0, 4_000\) \} : null/);
  });
});

describe('E. the doors and the send callers', () => {
  test('the four model doors are owner-gated by the union and call their functions', () => {
    const service = codeOnly(read('src/modules/agents/models-service.ts'));
    assert.match(service, /if \(!hasRole\(context, 'owner'\) \|\| !can\(context, 'organization\.settings'\)\)/);
    for (const fn of ['add_model', 'retire_model', 'set_fallback_chain', 'set_provider_budget']) assert.match(service, new RegExp(`rpc\\('${fn}'`));
    assert.match(codeOnly(read('src/modules/agents/work-classes-service.ts')), /rpc\('set_agent_work_classes'/);
  });

  test('every send_outbound_message caller answers outbound_paused', () => {
    const handlers = codeOnly(read('src/modules/crm/handlers.ts'));
    const calls = (handlers.match(/rpc\('send_outbound_message'/g) ?? []).length;
    const honoured = (handlers.match(/outcome === OUTBOUND_PAUSED\) return outboundPaused\(\);/g) ?? []).length;
    assert.ok(calls >= 10, `expected the ten send sites, found ${calls}`);
    assert.equal(honoured, calls);
    const service = codeOnly(read('src/modules/crm/service.ts'));
    assert.equal((service.match(/queued\.outcome === OUTBOUND_PAUSED\) return err\('FORBIDDEN', OUTBOUND_PAUSED_MESSAGE\);/g) ?? []).length, 2);
  });

  test('the registry page mounts the doors for the owner and the runs page filters by project and provider', () => {
    const routing = read('app/(internal)/agents/routing/page.tsx');
    assert.match(routing, /<AddModelForm providers=\{budgets\.map\(\(b\) => b\.provider\)\} \/>/);
    assert.match(routing, /<FallbackChainsPanel chains=\{chains\}/);
    assert.match(routing, /<ProviderBudgetsPanel budgets=\{budgets\}/);
    const runs = read('app/(internal)/usage/runs/page.tsx');
    assert.match(runs, /projectId: filters\.project/);
    assert.match(runs, /\(r\.providerId \?\? providerOfModel\(r\.model\)\) === filters\.provider/);
    const run = read('app/(internal)/usage/runs/[runId]/page.tsx');
    assert.match(run, /mayAct && mayReplay\(run\.workClass\) \? <ReplayRunForm runId=\{run\.id\} \/> : null/);
    assert.match(run, /Arguments &amp; result/);
  });
});
