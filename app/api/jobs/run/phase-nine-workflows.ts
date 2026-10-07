import { AgentsPaused } from '@/lib/ai/run-gates';
import type { Json } from '@/lib/db/types';
import { buildFinanceHandoff } from '@/modules/finance/phase-nine-handoff';
import {
  FINANCE_AGENTS,
  FINANCE_PROFILES,
  GOOD_PROPOSAL_OUTCOMES,
  checkFinanceProposals,
  doorArgsFor,
  financeProposalsJsonSchema,
  financeProposalsSchema,
  renderFinanceFacts,
  type FinanceAgent,
  type FinanceFacts,
} from '@/modules/finance/phase-nine-proposals';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun, type AgentContext } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * The three Phase 9 finance-agent workflows (`finance.<agent>.propose`), all built from ONE factory.
 *
 * UNPROVEN AGAINST A REAL MODEL. They are proven against a stand-in model and a stand-in database (tests/phase-nine-workflows.test.ts): what is proved
 * is the ORDER (read for the JOB's organization, ask, validate, then write), the REFUSALS and WHERE they write.
 *
 * A finance agent only PROPOSES. The job payload names a REQUEST (`finance.finance_agent_requests`, made by a Finance person or Admin through
 * `finance.request_finance_agent_run`, which also records who asked); the request names the project (and, for a reminder draft, the invoice). The
 * workflow reads the database's own position of that project and the records the agent may cite, ALL scoped to the claimed job's organization, asks the
 * model for strict JSON, validates every proposal against the facts it was shown, and writes ONLY through `finance.record_finance_proposal`. It never
 * verifies a payment, never changes an amount, never records a refund, never decides a waiver, never sends a message and never closes anything: a
 * person accepts or rejects a proposal, and the person who asked is not that person.
 *
 * Not subscribed to any event, and NOT yet in RUNNABLE_WORKFLOWS: the parent appends `...PHASE_NINE_WORKFLOWS` to that list. Until then the queue has no
 * claimant for these job kinds, and the three agents are installed disabled in any case.
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
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const door = (data: unknown): string => String(((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? 'no answer');

function buildWorkflow(agent: FinanceAgent): AgentWorkflow {
  const profile = FINANCE_PROFILES[agent];
  return {
    jobKind: `finance.${agent}.propose`,
    agentKey: agent,
    workClass: 'draft',
    systemPrompt: profile.prompt,
    schemaName: 'FinanceProposals',
    jsonSchema: financeProposalsJsonSchema,

    async run(ctx) {
      const { admin, job } = ctx;
      const requestId = str(job.payload?.requestId);
      if (!requestId) {
        await failJob(admin, job, 'job payload has no requestId');
        return { status: 'failed', reason: 'bad payload' };
      }
      const fin = loose(ctx).schema('finance');
      const projects = loose(ctx).schema('projects');
      const org = job.organization_id;
      const settle = async () => { await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id); };
      const fail = async (reason: string) => { await failJob(admin, job, reason); return { status: 'failed' as const, reason }; };

      // every read below is for THIS job's organization; the payload names a request, never a tenant
      const request = await fin.from('finance_agent_requests').select('id, agent_key, project_id, invoice_id, requested_by').eq('id', requestId).eq('organization_id', org).maybeSingle();
      if (request.error) return fail(`could not read the request: ${request.error.message}`);
      if (!request.data) {
        await settle();
        return { status: 'succeeded', outcome: 'gone', reason: 'the request no longer exists' };
      }
      if (request.data.agent_key !== agent) return fail('the request was made for a different finance agent');
      // an Admin may pause finance automation per organization: a paused agent does no work and its job goes back to the queue (an unreadable pause fails closed)
      const pause = await fin.rpc('finance_automation_is_paused', { p_organization_id: org, p_agent_key: agent });
      if (pause.error) return fail(`could not read the finance automation pause: ${pause.error.message}`);
      if (pause.data === true) throw new AgentsPaused({ jobId: job.id, runId: null, reason: 'finance automation is paused by an Admin' });
      const projectId = str(request.data.project_id);
      const invoiceId = str(request.data.invoice_id);
      if (!projectId) return fail('the request names no project');

      const project = await projects.from('projects').select('id, name, currency, client_account_id').eq('id', projectId).eq('organization_id', org).maybeSingle();
      if (project.error) return fail(`could not read the project: ${project.error.message}`);
      if (!project.data) {
        await settle();
        return { status: 'succeeded', outcome: 'gone', reason: 'the project no longer exists' };
      }

      // the database's OWN position (verified money only); the model reads it and never recomputes it
      const position = await fin.rpc('project_close_position', { p_project_id: projectId });
      if (position.error) return fail(`could not read the project's position: ${position.error.message}`);
      const pos = position.data as { result?: string; totals?: Record<string, number | string | null>; milestones?: Row[]; blockers?: Row[] } | null;
      if (!pos || typeof pos !== 'object') return fail('the project has no readable position');

      const invoices = await fin.from('invoices').select('id, number, status, total_minor, due_at').eq('project_id', projectId).eq('organization_id', org).order('created_at', { ascending: true }).limit(60);
      if (invoices.error) return fail(`could not read the invoices: ${invoices.error.message}`);
      const invoiceIds = (invoices.data ?? []).map((i) => String(i.id));

      const settledReads = await Promise.all([
        invoiceIds.length ? fin.from('payment_submissions').select('id, invoice_id, status, amount_minor, reference').in('invoice_id', invoiceIds).eq('organization_id', org).limit(100) : Promise.resolve({ data: [] as Row[], error: null }),
        invoiceIds.length ? fin.from('payments').select('id, invoice_id, amount_minor, status, verified_at').in('invoice_id', invoiceIds).eq('organization_id', org).limit(100) : Promise.resolve({ data: [] as Row[], error: null }),
        fin.from('finance_exceptions').select('id, kind, blocking, reason, invoice_id').eq('project_id', projectId).eq('organization_id', org).eq('state', 'open').limit(50),
        invoiceIds.length ? fin.from('finance_exceptions').select('id, kind, blocking, reason, invoice_id').in('invoice_id', invoiceIds).eq('organization_id', org).eq('state', 'open').limit(50) : Promise.resolve({ data: [] as Row[], error: null }),
        fin.from('waivers').select('id, status, amount_minor').eq('project_id', projectId).eq('organization_id', org).limit(50),
        projects.from('milestones').select('id, name').eq('project_id', projectId).eq('organization_id', org).order('position', { ascending: true }).limit(20),
      ]);
      const labels = ['payment submissions', 'payments', 'exceptions', 'invoice exceptions', 'waivers', 'milestones'];
      const broken = settledReads.findIndex((r) => r.error);
      if (broken >= 0) return fail(`could not read the ${labels[broken]}: ${settledReads[broken]?.error?.message}`);
      const rowsOf = (i: number): Row[] => settledReads[i]?.data ?? [];
      const submissions = rowsOf(0);
      const payments = rowsOf(1);
      const projectExceptions = rowsOf(2);
      const invoiceExceptions = rowsOf(3);
      const waivers = rowsOf(4);
      const milestones = rowsOf(5);

      // outstanding balance per invoice, computed by the database (never by the model, never here)
      const outstanding = new Map<string, number>();
      for (const id of invoiceIds) {
        const o = await fin.rpc('invoice_outstanding_minor', { p_invoice_id: id });
        if (o.error) return fail(`could not read an invoice balance: ${o.error.message}`);
        outstanding.set(id, num(o.data));
      }
      const exceptionById = new Map<string, Row>();
      for (const e of [...projectExceptions, ...invoiceExceptions]) exceptionById.set(String(e.id), e);

      let invoiceFact: FinanceFacts['invoice'] = null;
      if (invoiceId) {
        const inv = (invoices.data ?? []).find((i) => String(i.id) === invoiceId);
        if (!inv) {
          await settle();
          return { status: 'succeeded', outcome: 'gone', reason: 'the invoice no longer exists' };
        }
        const due = str(inv.due_at);
        const days = due ? Math.floor((Date.now() - new Date(due).getTime()) / 86_400_000) : null;
        invoiceFact = { id: invoiceId, number: String(inv.number), status: String(inv.status), outstandingMinor: outstanding.get(invoiceId) ?? 0, dueAt: due, daysOverdue: days !== null && days > 0 ? days : null };
      }

      const facts: FinanceFacts = {
        agent,
        projectName: str(project.data.name) ?? 'project',
        currency: str(project.data.currency) ?? 'INR',
        position: {
          result: String(pos.result ?? 'unknown'),
          totals: pos.totals ?? {},
          milestones: (pos.milestones ?? []).map((m) => ({
            name: String(m.name ?? ''), plannedMinor: num(m.plannedMinor), invoicedMinor: num(m.invoicedMinor), verifiedNetMinor: num(m.verifiedNetMinor),
            waivedMinor: num(m.waivedMinor), outstandingMinor: num(m.outstandingMinor), unverifiedMinor: num(m.unverifiedMinor),
          })),
          blockers: (pos.blockers ?? []).map((b) => ({ code: String(b.code ?? ''), reason: String(b.reason ?? ''), ref: str(b.ref) })),
        },
        invoices: (invoices.data ?? []).map((i) => ({ id: String(i.id), number: String(i.number), status: String(i.status), totalMinor: num(i.total_minor), outstandingMinor: outstanding.get(String(i.id)) ?? 0, dueAt: str(i.due_at) })),
        submissions: submissions.map((s) => ({ id: String(s.id), invoiceId: String(s.invoice_id), status: String(s.status), amountMinor: num(s.amount_minor), reference: str(s.reference) })),
        payments: payments.filter((p) => p.status === 'captured').map((p) => ({ id: String(p.id), invoiceId: String(p.invoice_id), amountMinor: num(p.amount_minor), verified: p.verified_at !== null && p.verified_at !== undefined })),
        exceptions: [...exceptionById.values()].map((e) => ({ id: String(e.id), kind: String(e.kind), blocking: e.blocking === true, reason: String(e.reason ?? '') })),
        milestoneIds: milestones.map((m) => ({ id: String(m.id), name: String(m.name ?? '') })),
        waivers: waivers.map((w) => ({ id: String(w.id), status: String(w.status), amountMinor: num(w.amount_minor) })),
        invoice: invoiceFact,
      };

      const runId = await openRun(ctx, { type: 'finance.agent_request', id: requestId, input: { requestId, agent, projectId } as unknown as Json });
      const call = await callModel(ctx, this, [{ role: 'user', content: renderFinanceFacts(facts) }], runId);
      if (!call.ok) {
        await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
        await failJob(admin, job, call.detail);
        return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
      }

      // strict, before anything is written: the shape, then every proposal against the facts and this agent's rules
      const parsed = financeProposalsSchema.safeParse(call.json);
      const checked = parsed.success ? checkFinanceProposals(agent, parsed.data, facts) : null;
      if (!parsed.success || (checked && !checked.ok)) {
        const detail = `the model's answer was refused: ${!parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : checked && !checked.ok ? checked.reason : 'unchecked'}`;
        await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
        await failJob(admin, job, detail);
        return { status: 'failed', reason: detail, runId };
      }
      if (!checked || !checked.ok) return { status: 'failed', reason: 'unchecked', runId };

      // one structured handoff payload per proposal, validated here and again by the door against the rows
      const requestedBy = str(request.data.requested_by);
      const handoffs = [];
      for (const p of checked.proposals) {
        const built = buildFinanceHandoff({
          organizationId: org, clientAccountId: str(project.data.client_account_id), projectId, requestId, requestedBy: requestedBy ?? '', proposal: p, agent,
          invoice: invoiceFact ? { id: invoiceFact.id, outstandingMinor: invoiceFact.outstandingMinor } : null, currency: facts.currency, financialState: facts.position.result,
          blockers: facts.position.blockers.map((b) => ({ code: b.code, ref: b.ref })), correlationId: job.correlation_id ?? null, attempt: job.attempts, maxAttempts: job.max_attempts,
        });
        if (!built.ok) {
          await finishRun(admin, runId, 'failed', built.reason, call.stepCount, call.usage);
          await failJob(admin, job, built.reason);
          return { status: 'failed', reason: built.reason, runId };
        }
        handoffs.push(built.handoff);
      }

      let proposed = 0;
      let already = 0;
      for (const [i, p] of checked.proposals.entries()) {
        const { data, error } = await fin.rpc('record_finance_proposal', { p_request_id: requestId, p_organization_id: org, p_agent_key: agent, ...doorArgsFor(p), p_handoff: handoffs[i] as unknown as Json });
        if (error) {
          await finishRun(admin, runId, 'failed', error.message, call.stepCount);
          await failJob(admin, job, `the door did not answer: ${error.message}`);
          return { status: 'failed', reason: error.message, runId };
        }
        const outcome = door(data);
        // an Admin paused this agent while the run was in flight: nothing more is written, and the job returns to the queue
        if (outcome === 'automation_paused') throw new AgentsPaused({ jobId: job.id, runId, reason: 'finance automation was paused by an Admin while this ran' });
        if (!GOOD_PROPOSAL_OUTCOMES.has(outcome)) {
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

export const PHASE_NINE_WORKFLOWS: readonly AgentWorkflow[] = FINANCE_AGENTS.map(buildWorkflow);
