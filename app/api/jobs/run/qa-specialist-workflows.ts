import type { Json } from '@/lib/db/types';
import {
  AGENT_PROFILES,
  QA_SPECIALIST_AGENTS,
  checkQaFindings,
  doorArgsFor,
  qaFindingsJsonSchema,
  qaFindingsSchema,
  renderQaFacts,
  type QaFacts,
  type QaSpecialistAgent,
} from '@/modules/projects/qa-specialist-findings';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun, type AgentContext } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * The nine Phase 6 QA specialist workflows (`qa.<agent>.propose`), all built from ONE factory.
 *
 * UNPROVEN AGAINST A REAL MODEL, A BROWSER, A DEVICE, A LOAD RIG OR A SECURITY TOOL. They are proven against a stand-in model and a stand-in database
 * (tests/qa-specialist-workflows.test.ts): what is proved is the ORDER (read for the JOB's organization, ask, validate, then write), the REFUSALS and
 * WHERE they write.
 *
 * A QA specialist only PROPOSES. The job payload names a REQUEST (`qa.specialist_requests`, made by a person through `qa.request_specialist_run`,
 * which also records who asked); the request names the QA job (or, for release_readiness, the release candidate). The workflow reads that job, its plan,
 * its cases and the records the agent may cite, ALL scoped to the claimed job's organization, asks the model for strict JSON, validates every proposal
 * against the facts it was shown, and writes ONLY through `qa.record_specialist_finding`. It never calls `qa.record_case_result`, never writes a
 * case, a plan, a candidate, an exception or a retest: a person turns an accepted proposal into a result.
 *
 * Not subscribed to any event, and NOT yet in RUNNABLE_WORKFLOWS: the parent appends `...QA_SPECIALIST_WORKFLOWS` to that list. Until then the queue
 * has no claimant for these job kinds, and the nine agents are installed disabled in any case.
 */

type Row = Record<string, unknown>;
type Answer = { data: Row[] | null; error: { message: string } | null };
type Query = PromiseLike<Answer> & {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  in(column: string, values: unknown[]): Query;
  order(column: string, options?: { ascending: boolean }): Query;
  limit(n: number): Query;
  maybeSingle(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
};
type Loose = { schema(name: string): { from(table: string): Query; rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> } };
const loose = (ctx: AgentContext): Loose => ctx.admin as unknown as Loose;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const door = (data: unknown): string => String(((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? 'no answer');

/** Outcomes of the finding door that are a good answer: the proposal exists (now, or from a redelivered run). */
const GOOD_DOOR_OUTCOMES = new Set(['proposed', 'already_proposed']);

function buildWorkflow(agent: QaSpecialistAgent): AgentWorkflow {
  const profile = AGENT_PROFILES[agent];
  return {
    jobKind: `qa.${agent}.propose`,
    agentKey: agent,
    workClass: 'draft',
    systemPrompt: profile.prompt,
    schemaName: 'QaSpecialistFindings',
    jsonSchema: qaFindingsJsonSchema,

    async run(ctx) {
      const { admin, job } = ctx;
      const requestId = str(job.payload?.requestId);
      if (!requestId) {
        await failJob(admin, job, 'job payload has no requestId');
        return { status: 'failed', reason: 'bad payload' };
      }
      const qa = loose(ctx).schema('qa');
      const projects = loose(ctx).schema('projects');
      const org = job.organization_id;
      const settle = async () => { await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id); };
      const fail = async (reason: string) => { await failJob(admin, job, reason); return { status: 'failed' as const, reason }; };

      // every read below is for THIS job's organization; the payload names a request, never a tenant
      const request = await qa.from('specialist_requests').select('id, agent_key, job_id, candidate_id, project_id').eq('id', requestId).eq('organization_id', org).maybeSingle();
      if (request.error) return fail(`could not read the request: ${request.error.message}`);
      if (!request.data) {
        await settle();
        return { status: 'succeeded', outcome: 'gone', reason: 'the request no longer exists' };
      }
      if (request.data.agent_key !== agent) return fail('the request was made for a different specialist');
      const projectId = str(request.data.project_id) ?? '';

      let category = 'release';
      let jobStatus: QaFacts['jobStatus'] = 'candidate';
      let planId: string | null = null;
      const jobId = str(request.data.job_id);
      const candidateId = str(request.data.candidate_id);
      let candidateCommit: string | null = null;
      if (jobId) {
        const qj = await qa.from('qa_jobs').select('id, plan_id, category, status, specialist').eq('id', jobId).eq('organization_id', org).maybeSingle();
        if (qj.error) return fail(`could not read the QA job: ${qj.error.message}`);
        if (!qj.data || qj.data.status === 'cancelled') {
          await settle();
          return { status: 'succeeded', outcome: 'gone', reason: 'the QA job no longer exists or was cancelled' };
        }
        if (qj.data.specialist !== agent) return fail('the QA job belongs to a different specialist');
        category = String(qj.data.category);
        jobStatus = qj.data.status === 'held' ? 'held' : 'routed';
        planId = str(qj.data.plan_id);
      } else if (candidateId) {
        const cand = await qa.from('release_candidates').select('id, plan_id, status, commit_ref').eq('id', candidateId).eq('organization_id', org).maybeSingle();
        if (cand.error) return fail(`could not read the release candidate: ${cand.error.message}`);
        if (!cand.data || cand.data.status === 'stale' || cand.data.status === 'superseded') {
          await settle();
          return { status: 'succeeded', outcome: 'gone', reason: 'the release candidate is no longer current' };
        }
        planId = str(cand.data.plan_id);
        candidateCommit = str(cand.data.commit_ref);
      }
      if (!planId) return fail('the request names neither a QA job nor a candidate');

      const plan = await qa.from('master_test_plans').select('id, status, commit_ref, environments').eq('id', planId).eq('organization_id', org).maybeSingle();
      if (plan.error) return fail(`could not read the plan: ${plan.error.message}`);
      if (!plan.data || plan.data.status !== 'approved') {
        await settle();
        return { status: 'succeeded', outcome: 'gone', reason: 'the plan is no longer the approved one' };
      }
      const commit = String(plan.data.commit_ref);
      if (candidateCommit !== null && candidateCommit !== commit) return fail('the candidate and the plan name different commits');

      // the facts: only what this agent may cite. A read that fails fails the job; the agent never proposes from a partial picture.
      const reads: [string, PromiseLike<Answer>][] = [];
      const named = (label: string, q: PromiseLike<Answer>): string => { reads.push([label, q]); return label; };
      const cases = jobId
        ? named('cases', qa.from('phase6_cases').select('id, title, acceptance_criterion, priority, status, journey, steps, expected').eq('plan_id', planId).eq('organization_id', org).eq('category', category).limit(300))
        : null;
      const runs = named('test runs', qa.from('test_runs').select('id, suite, passed, failed, executed_at').eq('project_id', projectId).eq('organization_id', org).order('executed_at', { ascending: false }).limit(20));
      const budgets = agent === 'performance_test' ? named('performance targets', qa.from('performance_budgets').select('metric, target, unit, lower_is_better').eq('project_id', projectId).eq('organization_id', org).limit(50)) : null;
      const devices = agent === 'compatibility_test' ? named('devices', qa.from('device_configurations').select('name, platform, status, reason').eq('organization_id', org).limit(60)) : null;
      const integrations = agent === 'api_integration_test' ? named('integrations', projects.from('integration_connections').select('name, kind, health, is_mock').eq('project_id', projectId).eq('organization_id', org)) : null;
      const defects = agent === 'regression_test' ? named('escaped defects', qa.from('defects').select('id, title').eq('project_id', projectId).eq('organization_id', org).in('status', ['fixed', 'verified', 'wontfix']).limit(100)) : null;
      const risks = agent === 'regression_test' ? named('escaped-defect risks', qa.from('risk_items').select('area, reason').eq('plan_id', planId).eq('organization_id', org).eq('kind', 'escaped_defect').limit(100)) : null;
      const assessment = candidateId ? named('readiness', qa.from('readiness_assessments').select('score, band, result, gates').eq('candidate_id', candidateId).eq('organization_id', org).order('evaluated_at', { ascending: false }).limit(1)) : null;
      const settled = await Promise.all(reads.map(async ([label, q]) => [label, await q] as const));
      const broken = settled.find(([, r]) => r.error);
      if (broken) return fail(`could not read the ${broken[0]}: ${broken[1].error?.message}`);
      // each query ran ONCE; its rows are looked up by label (a PromiseLike is never awaited twice)
      const byLabel = new Map(settled.map(([label, r]) => [label, r.data ?? []] as const));
      const rowsOf = (label: string | null): Row[] => (label ? (byLabel.get(label) ?? []) : []);

      const latestAssessment = rowsOf(assessment)[0];
      const gateRows = (latestAssessment?.gates ?? []) as unknown;
      const facts: QaFacts = {
        agent,
        category,
        commit,
        jobStatus,
        environments: Array.isArray(plan.data.environments) ? plan.data.environments.map(String) : [],
        cases: (rowsOf(cases)).map((c) => ({ id: String(c.id), title: String(c.title), criterion: String(c.acceptance_criterion), priority: String(c.priority), status: String(c.status), journey: str(c.journey), steps: str(c.steps), expected: str(c.expected) })),
        evidence: (rowsOf(runs)).map((r) => ({ ref: `run:${String(r.id)}`, detail: `${String(r.suite)}: ${Number(r.passed ?? 0)} passed, ${Number(r.failed ?? 0)} failed` })),
        budgets: (rowsOf(budgets)).map((b) => ({ metric: String(b.metric), target: Number(b.target), unit: String(b.unit), lowerIsBetter: b.lower_is_better !== false })),
        devices: (rowsOf(devices)).map((d) => ({ name: String(d.name), platform: String(d.platform), status: String(d.status), reason: str(d.reason) })),
        integrations: (rowsOf(integrations)).map((i) => ({ name: String(i.name), kind: String(i.kind), health: String(i.health), isMock: i.is_mock === true })),
        escaped: [
          ...(rowsOf(defects)).map((d) => ({ ref: `defect:${String(d.id)}`, title: String(d.title) })),
          ...(rowsOf(risks)).map((r) => ({ ref: `risk:${String(r.area)}`, title: String(r.reason) })),
        ],
        gates: Array.isArray(gateRows)
          ? (gateRows as Row[]).filter((g) => typeof g.gate === 'string').map((g) => ({ gate: String(g.gate), satisfied: g.satisfied === true, detail: String(g.detail ?? '') }))
          : [],
        readiness: latestAssessment ? `${String(latestAssessment.result)} (score ${Number(latestAssessment.score)}, ${String(latestAssessment.band)})` : null,
      };

      const runId = await openRun(ctx, { type: 'qa.specialist_request', id: requestId, input: { requestId, agent, category } as unknown as Json });
      const call = await callModel(ctx, this, [{ role: 'user', content: renderQaFacts(facts) }], runId);
      if (!call.ok) {
        await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
        await failJob(admin, job, call.detail);
        return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
      }

      // strict, before anything is written: the shape, then every proposal against the facts and this agent's rules
      const parsed = qaFindingsSchema.safeParse(call.json);
      const checked = parsed.success ? checkQaFindings(agent, parsed.data, facts) : null;
      if (!parsed.success || (checked && !checked.ok)) {
        const detail = `the model's answer was refused: ${!parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : checked && !checked.ok ? checked.reason : 'unchecked'}`;
        await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
        await failJob(admin, job, detail);
        return { status: 'failed', reason: detail, runId };
      }
      if (!checked || !checked.ok) return { status: 'failed', reason: 'unchecked', runId };

      let proposed = 0;
      let already = 0;
      for (const p of checked.findings) {
        const { data, error } = await qa.rpc('record_specialist_finding', { p_request_id: requestId, p_organization_id: org, p_agent_key: agent, ...doorArgsFor(p, commit) });
        if (error) {
          await finishRun(admin, runId, 'failed', error.message, call.stepCount);
          await failJob(admin, job, `the door did not answer: ${error.message}`);
          return { status: 'failed', reason: error.message, runId };
        }
        const outcome = door(data);
        if (!GOOD_DOOR_OUTCOMES.has(outcome)) {
          await finishRun(admin, runId, 'failed', `the door answered ${outcome}`, call.stepCount);
          await failJob(admin, job, `the door answered ${outcome}`);
          return { status: 'failed', reason: `the door answered ${outcome}`, runId };
        }
        if (outcome === 'proposed') proposed += 1;
        else already += 1;
      }
      await succeedRun(admin, runId, parsed.data as unknown as Json, call.usage, call.stepCount);
      await settle();
      return { status: 'succeeded', reason: 'proposed', runId, proposed, alreadyProposed: already };
    },
  };
}

export const QA_SPECIALIST_WORKFLOWS: readonly AgentWorkflow[] = QA_SPECIALIST_AGENTS.map(buildWorkflow);
