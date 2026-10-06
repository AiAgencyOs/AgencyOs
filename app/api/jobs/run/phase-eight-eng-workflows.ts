import type { Json } from '@/lib/db/types';
import {
  BILLING_PROMPT,
  JOB_KIND,
  MAINTENANCE_PLAN_PROMPTS,
  billingProposalJsonSchema,
  billingProposalSchema,
  checkBillingProposal,
  checkMaintenancePlan,
  maintenancePlanJsonSchema,
  maintenancePlanSchema,
  planDoorArgs,
  renderBillingFacts,
  renderMaintenanceFacts,
  type BillingFacts,
  type MaintenanceAgent,
  type MaintenanceFacts,
} from '@/modules/projects/maintenance-engineering';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun, type AgentContext } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * The Phase 8 part B engineering workflows: the Bug Fix agent's fix plan, the Regression agent's regression plan and the Finance agent's maintenance
 * billing proposal.
 *
 * UNPROVEN AGAINST A REAL MODEL. Proven against a stand-in model and database (tests/phase-eight-eng-workflows.test.ts): the ORDER (read for the JOB's
 * organization, ask, validate strictly, write), the REFUSALS and WHERE they write: one service-only door each, never a QA result, a commit, a release,
 * an invoice, a reminder send, an amount or a payment.
 *
 * Not subscribed to any event and NOT in RUNNABLE_WORKFLOWS: the parent appends `...PHASE_EIGHT_ENG_WORKFLOWS`. A person asks (a database door that
 * records who asked); the job payload names that request. The agents are installed disabled in any case.
 */

type Row = Record<string, unknown>;
type Answer = { data: Row[] | null; error: { message: string } | null };
type Query = PromiseLike<Answer> & {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  order(column: string, options?: { ascending: boolean }): Query;
  limit(n: number): Query;
  maybeSingle(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
};
type Loose = { schema(name: string): { from(table: string): Query; rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> } };
const loose = (ctx: AgentContext): Loose => ctx.admin as unknown as Loose;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const door = (data: unknown): string => String(((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? 'no answer');
const GOOD = new Set(['proposed', 'already_proposed']);

async function settle(ctx: AgentContext): Promise<void> {
  await ctx.admin.schema('core').from('jobs').update(settledSucceeded).eq('id', ctx.job.id);
}

function planWorkflow(agent: MaintenanceAgent): AgentWorkflow {
  return {
    jobKind: JOB_KIND[agent],
    agentKey: agent,
    workClass: 'draft',
    systemPrompt: MAINTENANCE_PLAN_PROMPTS[agent],
    schemaName: 'MaintenancePlan',
    jsonSchema: maintenancePlanJsonSchema,

    async run(ctx) {
      const { admin, job } = ctx;
      const requestId = str(job.payload?.requestId);
      if (!requestId) {
        await failJob(admin, job, 'job payload has no requestId');
        return { status: 'failed', reason: 'bad payload' };
      }
      const projects = loose(ctx).schema('projects');
      const qa = loose(ctx).schema('qa');
      const org = job.organization_id;
      const fail = async (reason: string) => { await failJob(admin, job, reason); return { status: 'failed' as const, reason }; };

      // every read is for THIS job's organization; the payload names a request, never a tenant
      const request = await projects.from('maintenance_agent_requests').select('id, agent_key, work_item_id').eq('id', requestId).eq('organization_id', org).maybeSingle();
      if (request.error) return fail(`could not read the request: ${request.error.message}`);
      if (!request.data) { await settle(ctx); return { status: 'succeeded', outcome: 'gone', reason: 'the request no longer exists' }; }
      if (request.data.agent_key !== agent) return fail('the request was made for a different agent');

      const item = await projects
        .from('maintenance_work_items')
        .select('id, project_id, kind, area, title, description, status, sensitive, commit_ref, fix_summary, defect_id, change_request_id, ticket_id')
        .eq('id', String(request.data.work_item_id)).eq('organization_id', org).maybeSingle();
      if (item.error) return fail(`could not read the work item: ${item.error.message}`);
      if (!item.data || item.data.status === 'cancelled' || item.data.status === 'released') {
        await settle(ctx);
        return { status: 'succeeded', outcome: 'gone', reason: 'the work item is closed or gone' };
      }

      // the facts: only what this agent may cite; a read that fails fails the job (never a proposal from a partial picture)
      const defectId = str(item.data.defect_id);
      const crId = str(item.data.change_request_id);
      const ticketId = str(item.data.ticket_id);
      const [defect, cr, ticket] = await Promise.all([
        defectId ? qa.from('defects').select('id, title, reproduction, expected, actual').eq('id', defectId).eq('organization_id', org).maybeSingle() : Promise.resolve({ data: null, error: null }),
        crId ? projects.from('change_requests').select('id, requested, classification').eq('id', crId).eq('organization_id', org).maybeSingle() : Promise.resolve({ data: null, error: null }),
        ticketId ? projects.from('maintenance_items').select('id, title, coverage').eq('id', ticketId).eq('organization_id', org).maybeSingle() : Promise.resolve({ data: null, error: null }),
      ]);
      if (defect.error) return fail(`could not read the defect: ${defect.error.message}`);
      if (cr.error) return fail(`could not read the change request: ${cr.error.message}`);
      if (ticket.error) return fail(`could not read the ticket: ${ticket.error.message}`);

      const evidence: { ref: string; detail: string }[] = [];
      if (defect.data) evidence.push({ ref: `defect:${String(defect.data.id)}`, detail: String(defect.data.title) });
      if (cr.data) evidence.push({ ref: `change_request:${String(cr.data.id)}`, detail: String(cr.data.requested).slice(0, 200) });
      if (ticket.data) evidence.push({ ref: `ticket:${String(ticket.data.id)}`, detail: String(ticket.data.title) });
      const commitRef = str(item.data.commit_ref);
      const facts: MaintenanceFacts = {
        agent,
        kind: String(item.data.kind),
        area: String(item.data.area),
        title: String(item.data.title),
        description: str(item.data.description),
        status: String(item.data.status),
        sensitive: item.data.sensitive === true,
        commitRef,
        fixSummary: str(item.data.fix_summary),
        defect: defect.data ? { title: String(defect.data.title), reproduction: str(defect.data.reproduction), expected: str(defect.data.expected), actual: str(defect.data.actual) } : null,
        changeRequest: cr.data ? { requested: String(cr.data.requested), classification: str(cr.data.classification) } : null,
        ticket: ticket.data ? { title: String(ticket.data.title), coverage: str(ticket.data.coverage) } : null,
        evidence,
      };

      const runId = await openRun(ctx, { type: 'maintenance.agent_request', id: requestId, input: { requestId, agent } as unknown as Json });
      const call = await callModel(ctx, this, [{ role: 'user', content: renderMaintenanceFacts(facts) }], runId);
      if (!call.ok) {
        await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
        await failJob(admin, job, call.detail);
        return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
      }

      // strict, before anything is written
      const parsed = maintenancePlanSchema.safeParse(call.json);
      const checked = parsed.success ? checkMaintenancePlan(agent, parsed.data, facts) : null;
      if (!parsed.success || !checked || !checked.ok) {
        const detail = `the model's answer was refused: ${!parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : checked && !checked.ok ? checked.reason : 'unchecked'}`;
        await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
        await failJob(admin, job, detail);
        return { status: 'failed', reason: detail, runId };
      }
      const { data, error } = await projects.rpc('record_maintenance_agent_proposal', { p_request_id: requestId, p_organization_id: org, p_agent_key: agent, ...planDoorArgs(agent, parsed.data, commitRef) });
      const outcome = error ? null : door(data);
      if (error || !outcome || !GOOD.has(outcome)) {
        const detail = error ? error.message : `the door answered ${outcome}`;
        await finishRun(admin, runId, 'failed', detail, call.stepCount);
        await failJob(admin, job, detail);
        return { status: 'failed', reason: detail, runId };
      }
      await succeedRun(admin, runId, parsed.data as unknown as Json, call.usage, call.stepCount);
      await settle(ctx);
      return { status: 'succeeded', reason: 'proposed', runId, proposed: outcome === 'proposed' ? 1 : 0, alreadyProposed: outcome === 'already_proposed' ? 1 : 0 };
    },
  };
}

const billingWorkflow: AgentWorkflow = {
  jobKind: JOB_KIND.finance,
  agentKey: 'finance',
  workClass: 'draft',
  systemPrompt: BILLING_PROMPT,
  schemaName: 'MaintenanceBillingProposal',
  jsonSchema: billingProposalJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const requestId = str(job.payload?.requestId);
    if (!requestId) {
      await failJob(admin, job, 'job payload has no requestId');
      return { status: 'failed', reason: 'bad payload' };
    }
    const finance = loose(ctx).schema('finance');
    const projects = loose(ctx).schema('projects');
    const org = job.organization_id;
    const fail = async (reason: string) => { await failJob(admin, job, reason); return { status: 'failed' as const, reason }; };

    const request = await finance.from('maintenance_billing_requests').select('id, kind, plan_id, change_request_id, invoice_id, client_account_id').eq('id', requestId).eq('organization_id', org).maybeSingle();
    if (request.error) return fail(`could not read the request: ${request.error.message}`);
    if (!request.data) { await settle(ctx); return { status: 'succeeded', outcome: 'gone', reason: 'the request no longer exists' }; }
    const kind = String(request.data.kind) as BillingFacts['kind'];

    const facts: BillingFacts = { kind, clientName: null, invoiceNumber: null, balanceMinor: null, currency: null, planName: null, changeRequestText: null, quotedLines: [] };
    const planId = str(request.data.plan_id);
    const crId = str(request.data.change_request_id);
    const invoiceId = str(request.data.invoice_id);
    if (kind === 'maintenance_invoice' && planId) {
      const plan = await projects.from('maintenance_plans').select('id, name, accepted_proposal_id').eq('id', planId).eq('organization_id', org).maybeSingle();
      if (plan.error) return fail(`could not read the plan: ${plan.error.message}`);
      if (!plan.data) { await settle(ctx); return { status: 'succeeded', outcome: 'gone', reason: 'the plan no longer exists' }; }
      facts.planName = String(plan.data.name);
      const items = await loose(ctx).schema('sales').from('proposal_items').select('description, quantity').eq('proposal_id', String(plan.data.accepted_proposal_id)).eq('organization_id', org).order('position', { ascending: true }).limit(50);
      if (items.error) return fail(`could not read the quote: ${items.error.message}`);
      facts.quotedLines = (items.data ?? []).map((r) => ({ description: String(r.description), quantity: Number(r.quantity) }));
    } else if (kind === 'change_request_invoice' && crId) {
      const cr = await projects.from('change_requests').select('id, requested, proposal_id').eq('id', crId).eq('organization_id', org).maybeSingle();
      if (cr.error) return fail(`could not read the change request: ${cr.error.message}`);
      if (!cr.data) { await settle(ctx); return { status: 'succeeded', outcome: 'gone', reason: 'the change request no longer exists' }; }
      facts.changeRequestText = String(cr.data.requested).slice(0, 300);
      const items = await loose(ctx).schema('sales').from('proposal_items').select('description, quantity').eq('proposal_id', String(cr.data.proposal_id)).eq('organization_id', org).order('position', { ascending: true }).limit(50);
      if (items.error) return fail(`could not read the quote: ${items.error.message}`);
      facts.quotedLines = (items.data ?? []).map((r) => ({ description: String(r.description), quantity: Number(r.quantity) }));
    } else if (kind === 'payment_reminder' && invoiceId) {
      const inv = await finance.from('invoices').select('id, number, status, currency').eq('id', invoiceId).eq('organization_id', org).maybeSingle();
      if (inv.error) return fail(`could not read the invoice: ${inv.error.message}`);
      if (!inv.data || !['issued', 'partially_paid', 'overdue'].includes(String(inv.data.status))) {
        // reminders stop when the invoice is no longer collectible
        await settle(ctx);
        return { status: 'succeeded', outcome: 'gone', reason: 'the invoice is no longer collectible: no reminder is prepared' };
      }
      facts.invoiceNumber = String(inv.data.number);
      facts.currency = str(inv.data.currency);
    } else {
      return fail('the request does not carry what its kind needs');
    }
    const client = await loose(ctx).schema('core').from('client_accounts').select('id, name').eq('id', String(request.data.client_account_id)).eq('organization_id', org).maybeSingle();
    if (client.error) return fail(`could not read the client: ${client.error.message}`);
    facts.clientName = client.data ? str(client.data.name) : null;

    const runId = await openRun(ctx, { type: 'finance.maintenance_billing_request', id: requestId, input: { requestId, kind } as unknown as Json });
    const call = await callModel(ctx, this, [{ role: 'user', content: renderBillingFacts(facts) }], runId);
    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failJob(admin, job, call.detail);
      return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
    }
    const parsed = billingProposalSchema.safeParse(call.json);
    const checked = parsed.success ? checkBillingProposal(parsed.data, facts) : null;
    if (!parsed.success || !checked || !checked.ok) {
      const detail = `the model's answer was refused: ${!parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : checked && !checked.ok ? checked.reason : 'unchecked'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }
    // the ONE door: it takes a narrative and a reminder text, and no amount
    const { data, error } = await finance.rpc('record_maintenance_billing_proposal', { p_request_id: requestId, p_organization_id: org, p_agent_key: 'finance', p_narrative: parsed.data.narrative, p_reminder_text: parsed.data.reminderText });
    const outcome = error ? null : door(data);
    if (error || !outcome || !GOOD.has(outcome)) {
      const detail = error ? error.message : `the door answered ${outcome}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }
    await succeedRun(admin, runId, parsed.data as unknown as Json, call.usage, call.stepCount);
    await settle(ctx);
    return { status: 'succeeded', reason: 'proposed', runId, proposed: outcome === 'proposed' ? 1 : 0, alreadyProposed: outcome === 'already_proposed' ? 1 : 0 };
  },
};

export const PHASE_EIGHT_ENG_WORKFLOWS: readonly AgentWorkflow[] = [planWorkflow('bug_fix'), planWorkflow('regression_test'), billingWorkflow];
