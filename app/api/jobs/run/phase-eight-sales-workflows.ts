import type { Json } from '@/lib/db/types';
import {
  checkDiscoveryBrief,
  discoveryBriefSchema,
  discoveryJsonSchema,
  discoverySystemPrompt,
  renderDiscoveryFacts,
  type DiscoveryFacts,
} from '@/modules/projects/phase-eight-sales-proposals';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun, type AgentContext } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * The post-launch Sales agent's workflow `sales.draft_discovery_brief`.
 *
 * UNPROVEN AGAINST A REAL MODEL. It is proven against a stand-in model and a stand-in database (tests/phase-eight-sales-workflow.test.ts): what is proved is the
 * ORDER (read for the JOB's organization, ask, validate, then write), the REFUSALS and WHERE it writes: exactly ONE service-role door, projects.record_discovery_brief_draft,
 * which stores a DRAFT for an opportunity a PERSON has already qualified, citing the Customer 360 records it used. It never qualifies, hands off, opens a deal, quotes,
 * discounts or contacts anybody. The payload names a RECORD (an opportunity), never a tenant. It is not in RUNNABLE_WORKFLOWS and nothing enqueues it: the parent
 * appends `...PHASE_EIGHT_SALES_WORKFLOWS`, and running it needs a funded model key (without one it fails honestly with AI_PROVIDER_NOT_CONFIGURED).
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
type Loose = {
  schema(name: string): {
    from(table: string): Query;
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
};
const loose = (ctx: AgentContext): Loose => ctx.admin as unknown as Loose;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const door = (data: unknown): string => String(((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? 'no answer');

async function settle(ctx: AgentContext): Promise<void> {
  await ctx.admin.schema('core').from('jobs').update(settledSucceeded).eq('id', ctx.job.id);
}

const gone = async (ctx: AgentContext, reason: string) => {
  await settle(ctx);
  return { status: 'succeeded' as const, outcome: 'gone', reason };
};

const discoveryWorkflow: AgentWorkflow = {
  jobKind: 'sales.draft_discovery_brief',
  agentKey: 'sales',
  workClass: 'draft',
  systemPrompt: discoverySystemPrompt,
  schemaName: 'DiscoveryBrief',
  jsonSchema: discoveryJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const opportunityId = str(job.payload?.opportunityId) ?? str(job.payload?.subjectId);
    if (!opportunityId) {
      await failJob(admin, job, 'job payload has no opportunityId');
      return { status: 'failed', reason: 'bad payload' };
    }
    const projects = loose(ctx).schema('projects');
    const sales = loose(ctx).schema('sales');
    const org = job.organization_id;
    const fail = async (reason: string) => {
      await failJob(admin, job, reason);
      return { status: 'failed' as const, reason };
    };

    // every read below is for THIS job's organization
    const opp = await sales.from('phase_eight_opportunities').select('id, project_id, kind, need, urgency, status').eq('id', opportunityId).eq('organization_id', org).maybeSingle();
    if (opp.error) return fail(`could not read the opportunity: ${opp.error.message}`);
    if (!opp.data || (opp.data.status !== 'qualified' && opp.data.status !== 'handed_off')) return gone(ctx, 'the opportunity no longer exists or is not qualified');
    const projectId = str(opp.data.project_id) ?? '';

    const project = await projects.from('projects').select('name').eq('id', projectId).eq('organization_id', org).maybeSingle();
    if (project.error) return fail(`could not read the project: ${project.error.message}`);
    if (!project.data) return gone(ctx, 'the project no longer exists');
    const tickets = await projects.from('support_tickets').select('id, title, classification, status').eq('project_id', projectId).eq('organization_id', org).order('raised_at', { ascending: false }).limit(15);
    if (tickets.error) return fail(`could not read the tickets: ${tickets.error.message}`);
    const checkIns = await projects.from('cs_check_ins').select('id, kind, outcome').eq('project_id', projectId).eq('organization_id', org).eq('status', 'completed').order('completed_at', { ascending: false }).limit(10);
    if (checkIns.error) return fail(`could not read the check-ins: ${checkIns.error.message}`);
    const health = await projects.rpc('customer_health_status', { p_project_id: projectId });
    if (health.error) return fail(`could not read the derived health: ${health.error.message}`);
    const healthRow = (Array.isArray(health.data) ? health.data[0] : health.data) as { status?: string } | undefined;

    const facts: DiscoveryFacts = {
      projectName: String(project.data.name ?? ''),
      healthStatus: str(healthRow?.status),
      opportunity: { kind: String(opp.data.kind ?? ''), need: String(opp.data.need ?? ''), urgency: String(opp.data.urgency ?? 'normal') },
      tickets: (tickets.data ?? []).map((t) => ({ id: String(t.id), title: String(t.title), classification: str(t.classification), status: String(t.status) })),
      checkIns: (checkIns.data ?? []).map((c) => ({ id: String(c.id), kind: String(c.kind), outcome: str(c.outcome) })),
    };

    const runId = await openRun(ctx, { type: 'sales.phase_eight_opportunity', id: opportunityId, input: { opportunityId, projectId } as unknown as Json });
    const call = await callModel(ctx, this, [{ role: 'user', content: renderDiscoveryFacts(facts) }], runId);
    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failJob(admin, job, call.detail);
      return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
    }

    // strict, before anything is written: the shape, then the rules against the facts
    const parsed = discoveryBriefSchema.safeParse(call.json);
    const verdict = parsed.success ? checkDiscoveryBrief(parsed.data, facts) : null;
    if (!parsed.success || (verdict && !verdict.ok)) {
      const detail = `the model's answer was refused: ${!parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : verdict && !verdict.ok ? verdict.reason : 'unchecked'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }
    const b = parsed.data;

    const { data, error } = await projects.rpc('record_discovery_brief_draft', {
      p_organization_id: org,
      p_opportunity_id: opportunityId,
      p_agent_key: 'sales',
      p_summary: b.summary,
      p_questions: b.questions,
      p_context_refs: { ticketIds: b.citedTicketIds, checkInIds: b.citedCheckInIds },
    });
    if (error) {
      await finishRun(admin, runId, 'failed', error.message, call.stepCount);
      await failJob(admin, job, `the door did not answer: ${error.message}`);
      return { status: 'failed', reason: error.message, runId };
    }
    const outcome = door(data);
    // 'already_recorded' is a good answer: the same brief is on record and a retried run records no second
    if (outcome !== 'drafted' && outcome !== 'already_recorded') {
      await finishRun(admin, runId, 'failed', `the door answered ${outcome}`, call.stepCount);
      await failJob(admin, job, `the door answered ${outcome}`);
      return { status: 'failed', reason: `the door answered ${outcome}`, runId };
    }
    await succeedRun(admin, runId, b as unknown as Json, call.usage, call.stepCount);
    await settle(ctx);
    return { status: 'succeeded', reason: outcome, runId };
  },
};

export const PHASE_EIGHT_SALES_WORKFLOWS: readonly AgentWorkflow[] = [discoveryWorkflow];
