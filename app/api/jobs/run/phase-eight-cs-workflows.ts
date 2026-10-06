import type { Json } from '@/lib/db/types';
import {
  agendaJsonSchema,
  agendaSchema,
  agendaSystemPrompt,
  checkAgenda,
  checkOpportunity,
  checkSupportProposal,
  opportunityJsonSchema,
  opportunitySchema,
  opportunitySystemPrompt,
  renderAgenda,
  renderAgendaFacts,
  renderOpportunityFacts,
  renderSupportFacts,
  supportJsonSchema,
  supportProposalSchema,
  supportSystemPrompt,
  type AgendaFacts,
  type OpportunityFacts,
  type SupportFacts,
} from '@/modules/projects/phase-eight-proposals';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun, type AgentContext } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * The three Phase 8A agent workflows: `support.propose_ticket_handling`, `customer_success.draft_check_in_agenda` and `upsell.propose_opportunity`.
 *
 * UNPROVEN AGAINST A REAL MODEL. They are proven against a stand-in model and a stand-in database (tests/phase-eight-cs-workflows.test.ts): what is proved
 * is the ORDER (read for the JOB's organization, ask, validate, then write), the REFUSALS and WHERE they write. All three are DRAFT work and each writes through
 * exactly ONE service-role door:
 *
 *   support        -> projects.record_support_proposal      a proposed classification and a reply DRAFT; never the classification, never a send
 *   customer_success -> projects.record_check_in_agenda     an agenda on a DUE check-in; never completes one, never contacts anybody
 *   upsell         -> sales.record_phase_eight_opportunity  an opportunity DETECTED from evidence; never qualifies, hands off, quotes or discounts
 *
 * The payload names a RECORD (a ticket, a check-in, a project), never a tenant: every read is scoped to the claimed job's organization and a record in another
 * organization is simply not there. None of them is subscribed to an event and none is in RUNNABLE_WORKFLOWS yet: the parent appends `...PHASE_EIGHT_CS_WORKFLOWS`.
 * The agents are not enabled in any case: activation is a separate decision that needs a funded model key.
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

// ── Support ─────────────────────────────────────────────────────────────────────────────────────

const supportWorkflow: AgentWorkflow = {
  jobKind: 'support.propose_ticket_handling',
  agentKey: 'support',
  workClass: 'draft',
  systemPrompt: supportSystemPrompt,
  schemaName: 'SupportTicketProposal',
  jsonSchema: supportJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const ticketId = str(job.payload?.ticketId) ?? str(job.payload?.subjectId);
    if (!ticketId) {
      await failJob(admin, job, 'job payload has no ticketId');
      return { status: 'failed', reason: 'bad payload' };
    }
    const projects = loose(ctx).schema('projects');
    const org = job.organization_id;
    const fail = async (reason: string) => {
      await failJob(admin, job, reason);
      return { status: 'failed' as const, reason };
    };

    // every read below is for THIS job's organization
    const ticket = await projects.from('support_tickets').select('id, project_id, title, description, status, raised_at').eq('id', ticketId).eq('organization_id', org).maybeSingle();
    if (ticket.error) return fail(`could not read the ticket: ${ticket.error.message}`);
    if (!ticket.data || ticket.data.status === 'closed' || ticket.data.status === 'cancelled') return gone(ctx, 'the ticket no longer exists or is closed');
    const projectId = str(ticket.data.project_id) ?? '';

    const workspace = await projects.from('phase_eight').select('state, warranty_starts_on, warranty_ends_on').eq('project_id', projectId).eq('organization_id', org).maybeSingle();
    if (workspace.error) return fail(`could not read the workspace: ${workspace.error.message}`);
    if (!workspace.data) return fail('the project has no Phase 8 workspace');
    const plans = await projects.from('maintenance_plans').select('name, version, status, starts_on, ends_on').eq('project_id', projectId).eq('organization_id', org).in('status', ['active', 'renewed', 'renewal_approaching']).limit(10);
    if (plans.error) return fail(`could not read the maintenance plans: ${plans.error.message}`);
    const recent = await projects.from('support_tickets').select('title, classification').eq('project_id', projectId).eq('organization_id', org).order('raised_at', { ascending: false }).limit(6);
    if (recent.error) return fail(`could not read the recent tickets: ${recent.error.message}`);

    const raisedDay = String(ticket.data.raised_at ?? '').slice(0, 10);
    const starts = str(workspace.data.warranty_starts_on);
    const ends = str(workspace.data.warranty_ends_on);
    const facts: SupportFacts = {
      title: String(ticket.data.title ?? ''),
      description: str(ticket.data.description),
      status: String(ticket.data.status),
      raisedWithinWarranty: starts !== null && ends !== null && raisedDay >= starts && raisedDay <= ends,
      warrantyWindow: starts && ends ? `${starts} to ${ends}` : 'no warranty',
      activePlans: (plans.data ?? []).map((p) => ({ name: String(p.name), version: Number(p.version), status: String(p.status), startsOn: str(p.starts_on), endsOn: str(p.ends_on) })),
      recent: (recent.data ?? []).filter((r) => String(r.title) !== String(ticket.data?.title)).map((r) => ({ title: String(r.title), classification: str(r.classification) })),
    };

    const runId = await openRun(ctx, { type: 'projects.support_ticket', id: ticketId, input: { ticketId, projectId } as unknown as Json });
    const call = await callModel(ctx, this, [{ role: 'user', content: renderSupportFacts(facts) }], runId);
    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failJob(admin, job, call.detail);
      return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
    }

    // strict, before anything is written: the shape, then the rules against the facts
    const parsed = supportProposalSchema.safeParse(call.json);
    const verdict = parsed.success ? checkSupportProposal(parsed.data, facts) : null;
    if (!parsed.success || (verdict && !verdict.ok)) {
      const detail = `the model's answer was refused: ${!parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : verdict && !verdict.ok ? verdict.reason : 'unchecked'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }
    const p = parsed.data;

    const { data, error } = await projects.rpc('record_support_proposal', {
      p_organization_id: org,
      p_ticket_id: ticketId,
      p_agent_key: 'support',
      p_proposed_classification: p.proposedClassification,
      p_rationale: p.rationale,
      p_draft_body: p.draftReply,
      p_language: p.language,
    });
    if (error) {
      await finishRun(admin, runId, 'failed', error.message, call.stepCount);
      await failJob(admin, job, `the door did not answer: ${error.message}`);
      return { status: 'failed', reason: error.message, runId };
    }
    const outcome = door(data);
    // 'already_proposed' is a good answer: the same proposal is on record and is never stored twice
    if (outcome !== 'proposed' && outcome !== 'already_proposed') {
      await finishRun(admin, runId, 'failed', `the door answered ${outcome}`, call.stepCount);
      await failJob(admin, job, `the door answered ${outcome}`);
      return { status: 'failed', reason: `the door answered ${outcome}`, runId };
    }
    await succeedRun(admin, runId, p as unknown as Json, call.usage, call.stepCount);
    await settle(ctx);
    return { status: 'succeeded', reason: outcome, runId };
  },
};

// ── Customer Success ───────────────────────────────────────────────────────────────────────────

const agendaWorkflow: AgentWorkflow = {
  jobKind: 'customer_success.draft_check_in_agenda',
  agentKey: 'customer_success',
  workClass: 'draft',
  systemPrompt: agendaSystemPrompt,
  schemaName: 'CheckInAgenda',
  jsonSchema: agendaJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const checkInId = str(job.payload?.checkInId) ?? str(job.payload?.subjectId);
    if (!checkInId) {
      await failJob(admin, job, 'job payload has no checkInId');
      return { status: 'failed', reason: 'bad payload' };
    }
    const projects = loose(ctx).schema('projects');
    const org = job.organization_id;
    const fail = async (reason: string) => {
      await failJob(admin, job, reason);
      return { status: 'failed' as const, reason };
    };

    const checkIn = await projects.from('cs_check_ins').select('id, project_id, kind, status').eq('id', checkInId).eq('organization_id', org).maybeSingle();
    if (checkIn.error) return fail(`could not read the check-in: ${checkIn.error.message}`);
    if (!checkIn.data || checkIn.data.status !== 'due') return gone(ctx, 'the check-in no longer exists or is no longer due');
    const projectId = str(checkIn.data.project_id) ?? '';

    const project = await projects.from('projects').select('name').eq('id', projectId).eq('organization_id', org).maybeSingle();
    if (project.error) return fail(`could not read the project: ${project.error.message}`);
    if (!project.data) return gone(ctx, 'the project no longer exists');
    const workspace = await projects.from('phase_eight').select('warranty_ends_on').eq('project_id', projectId).eq('organization_id', org).maybeSingle();
    if (workspace.error) return fail(`could not read the workspace: ${workspace.error.message}`);
    if (!workspace.data) return fail('the project has no Phase 8 workspace');
    const health = await projects.rpc('customer_health_status', { p_project_id: projectId });
    if (health.error) return fail(`could not read the derived health: ${health.error.message}`);
    const tickets = await projects.from('support_tickets').select('id, title, priority, status').eq('project_id', projectId).eq('organization_id', org).in('status', ['new', 'classified', 'assigned', 'in_progress', 'in_qa', 'release', 'client_confirmation']).limit(15);
    if (tickets.error) return fail(`could not read the open tickets: ${tickets.error.message}`);
    const plans = await projects.from('maintenance_plans').select('name, status, ends_on').eq('project_id', projectId).eq('organization_id', org).limit(10);
    if (plans.error) return fail(`could not read the maintenance plans: ${plans.error.message}`);
    const last = await projects.from('cs_check_ins').select('kind, outcome').eq('project_id', projectId).eq('organization_id', org).eq('status', 'completed').order('completed_at', { ascending: false }).limit(3);
    if (last.error) return fail(`could not read the earlier check-ins: ${last.error.message}`);

    const healthRow = (Array.isArray(health.data) ? health.data[0] : health.data) as { status?: string; reasons?: { signal: string; value: string; level: string }[] } | undefined;
    const facts: AgendaFacts = {
      projectName: String(project.data.name ?? ''),
      healthStatus: str(healthRow?.status),
      signals: Array.isArray(healthRow?.reasons) ? healthRow.reasons.map((s) => ({ signal: String(s.signal), value: String(s.value), level: String(s.level) })) : [],
      openTickets: (tickets.data ?? []).map((t) => ({ id: String(t.id), title: String(t.title), priority: str(t.priority), status: String(t.status) })),
      plans: (plans.data ?? []).map((p) => ({ name: String(p.name), status: String(p.status), endsOn: str(p.ends_on) })),
      lastCheckIns: (last.data ?? []).map((c) => ({ kind: String(c.kind), outcome: str(c.outcome) })),
      warrantyEndsOn: str(workspace.data.warranty_ends_on),
    };

    const runId = await openRun(ctx, { type: 'projects.cs_check_in', id: checkInId, input: { checkInId, projectId } as unknown as Json });
    const call = await callModel(ctx, this, [{ role: 'user', content: renderAgendaFacts(facts) }], runId);
    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failJob(admin, job, call.detail);
      return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
    }
    const parsed = agendaSchema.safeParse(call.json);
    const verdict = parsed.success ? checkAgenda(parsed.data, facts) : null;
    if (!parsed.success || (verdict && !verdict.ok)) {
      const detail = `the model's answer was refused: ${!parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : verdict && !verdict.ok ? verdict.reason : 'unchecked'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    const { data, error } = await projects.rpc('record_check_in_agenda', { p_organization_id: org, p_check_in_id: checkInId, p_agent_key: 'customer_success', p_agenda: renderAgenda(parsed.data) });
    if (error) {
      await finishRun(admin, runId, 'failed', error.message, call.stepCount);
      await failJob(admin, job, `the door did not answer: ${error.message}`);
      return { status: 'failed', reason: error.message, runId };
    }
    const outcome = door(data);
    // 'already_recorded' is a good answer; a person-written agenda is never overwritten and is not a failure to hide
    if (outcome !== 'recorded' && outcome !== 'already_recorded' && outcome !== 'a_person_wrote_the_agenda') {
      await finishRun(admin, runId, 'failed', `the door answered ${outcome}`, call.stepCount);
      await failJob(admin, job, `the door answered ${outcome}`);
      return { status: 'failed', reason: `the door answered ${outcome}`, runId };
    }
    await succeedRun(admin, runId, parsed.data as unknown as Json, call.usage, call.stepCount);
    await settle(ctx);
    return { status: 'succeeded', reason: outcome, runId };
  },
};

// ── Upsell ─────────────────────────────────────────────────────────────────────────────────────

const opportunityWorkflow: AgentWorkflow = {
  jobKind: 'upsell.propose_opportunity',
  agentKey: 'upsell',
  workClass: 'draft',
  systemPrompt: opportunitySystemPrompt,
  schemaName: 'ExpansionOpportunity',
  jsonSchema: opportunityJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const projectId = str(job.payload?.projectId) ?? str(job.payload?.subjectId);
    if (!projectId) {
      await failJob(admin, job, 'job payload has no projectId');
      return { status: 'failed', reason: 'bad payload' };
    }
    const projects = loose(ctx).schema('projects');
    const sales = loose(ctx).schema('sales');
    const org = job.organization_id;
    const fail = async (reason: string) => {
      await failJob(admin, job, reason);
      return { status: 'failed' as const, reason };
    };

    const project = await projects.from('projects').select('name, status').eq('id', projectId).eq('organization_id', org).maybeSingle();
    if (project.error) return fail(`could not read the project: ${project.error.message}`);
    if (!project.data) return gone(ctx, 'the project no longer exists');
    const workspace = await projects.from('phase_eight').select('state').eq('project_id', projectId).eq('organization_id', org).maybeSingle();
    if (workspace.error) return fail(`could not read the workspace: ${workspace.error.message}`);
    if (!workspace.data) return fail('the project has no Phase 8 workspace');
    const tickets = await projects.from('support_tickets').select('id, title, description, classification').eq('project_id', projectId).eq('organization_id', org).in('classification', ['change_request', 'new_project']).order('raised_at', { ascending: false }).limit(10);
    if (tickets.error) return fail(`could not read the out-of-scope tickets: ${tickets.error.message}`);
    const checkIns = await projects.from('cs_check_ins').select('id, kind, outcome').eq('project_id', projectId).eq('organization_id', org).eq('status', 'completed').order('completed_at', { ascending: false }).limit(5);
    if (checkIns.error) return fail(`could not read the check-ins: ${checkIns.error.message}`);
    const signals = await sales.from('upsell_signals').select('id, kind').eq('project_id', projectId).eq('organization_id', org).limit(5);
    if (signals.error) return fail(`could not read the upsell signals: ${signals.error.message}`);
    const health = await projects.rpc('customer_health_status', { p_project_id: projectId });
    if (health.error) return fail(`could not read the derived health: ${health.error.message}`);
    const healthRow = (Array.isArray(health.data) ? health.data[0] : health.data) as { status?: string } | undefined;

    const facts: OpportunityFacts = {
      projectName: String(project.data.name ?? ''),
      healthStatus: str(healthRow?.status),
      tickets: (tickets.data ?? []).map((t) => ({ id: String(t.id), title: String(t.title), description: str(t.description), classification: str(t.classification) })),
      checkIns: (checkIns.data ?? []).map((c) => ({ id: String(c.id), kind: String(c.kind), outcome: str(c.outcome) })),
      signals: (signals.data ?? []).map((s) => ({ id: String(s.id), kind: String(s.kind) })),
    };

    const runId = await openRun(ctx, { type: 'sales.phase_eight_opportunity', id: projectId, input: { projectId } as unknown as Json });
    const call = await callModel(ctx, this, [{ role: 'user', content: renderOpportunityFacts(facts) }], runId);
    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failJob(admin, job, call.detail);
      return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
    }
    const parsed = opportunitySchema.safeParse(call.json);
    const verdict = parsed.success ? checkOpportunity(parsed.data, facts) : null;
    if (!parsed.success || (verdict && !verdict.ok)) {
      const detail = `the model's answer was refused: ${!parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : verdict && !verdict.ok ? verdict.reason : 'unchecked'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }
    const p = parsed.data;

    // no legitimate opportunity is a good, complete answer: nothing is written
    if (p.opportunity === null) {
      await succeedRun(admin, runId, p as unknown as Json, call.usage, call.stepCount);
      await settle(ctx);
      return { status: 'succeeded', outcome: 'no_opportunity', reason: p.reason, runId };
    }
    const o = p.opportunity;
    const { data, error } = await sales.rpc('record_phase_eight_opportunity', {
      p_project_id: projectId,
      p_kind: o.kind,
      p_need: o.need,
      p_evidence: o.evidence,
      p_requested_outcome: o.requestedOutcome,
      p_urgency: o.urgency,
      p_stakeholders: o.stakeholders,
      p_constraints: o.constraints,
      p_agent_key: 'upsell',
      p_organization_id: org,
    });
    if (error) {
      await finishRun(admin, runId, 'failed', error.message, call.stepCount);
      await failJob(admin, job, `the door did not answer: ${error.message}`);
      return { status: 'failed', reason: error.message, runId };
    }
    const outcome = door(data);
    // 'duplicate' is a good answer: the same evidence already has its opportunity and a retried run records no second
    if (outcome !== 'recorded' && outcome !== 'duplicate') {
      await finishRun(admin, runId, 'failed', `the door answered ${outcome}`, call.stepCount);
      await failJob(admin, job, `the door answered ${outcome}`);
      return { status: 'failed', reason: `the door answered ${outcome}`, runId };
    }
    await succeedRun(admin, runId, p as unknown as Json, call.usage, call.stepCount);
    await settle(ctx);
    return { status: 'succeeded', reason: outcome, runId };
  },
};

export const PHASE_EIGHT_CS_WORKFLOWS: readonly AgentWorkflow[] = [supportWorkflow, agendaWorkflow, opportunityWorkflow];
