import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { generateFreeMaintenanceInvoices, generateFirstMilestoneInvoice, generateM2Invoice, generateM3Invoice, generateM4Invoice } from './service';

/**
 * Job handlers for the finance module.
 *
 * Same boundary `projects/handlers.ts` documents: a job runs behind the
 * cron-authenticated runner on the service-role client, with no session and
 * no RLS, so every query in `generateFirstMilestoneInvoice` scopes by
 * organization_id and project_id from the JOB — never from the event payload,
 * which is the untrusted part.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type HandlerResult =
  | { status: 'succeeded'; outcome: string; detail: string; invoiceId?: string }
  | { status: 'failed'; permanent: boolean; detail: string };

/** The envelope lib/events/dispatch.ts writes into core.jobs.payload. */
type JobEnvelope = {
  eventId?: number;
  eventType?: string;
  subjectType?: string | null;
  subjectId?: string | null;
  event?: unknown;
};

export type BillingModeJob = {
  id: string;
  organization_id: string;
  payload: JobEnvelope | null;
  correlation_id: string | null;
};

/**
 * `project.billing_mode_confirmed` → auto-raise the M1 invoice.
 *
 * The receiver for Phase 2 Master Flow §5–§6's automated Finance-agent
 * reaction: GST/Non-GST confirmation → M1 invoice, with no person required to
 * open the project page first. Every decision — whether a locked M1
 * milestone exists, whether it is already invoiced, whether the billing
 * profile is genuinely complete — lives in `generateFirstMilestoneInvoice`;
 * this claims the job and translates its outcome.
 *
 * `finance.confirm_billing_mode` emits the event with `subject_id` set to the
 * project, which is what this handler trusts — the same rule
 * `handleHandoffBound` and `handleInvoicePaid` already apply.
 */
export async function handleBillingModeConfirmed(admin: Admin, job: BillingModeJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const projectId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;

  if (!projectId) {
    return { status: 'failed', permanent: true, detail: 'the event named no project' };
  }

  const result = await generateFirstMilestoneInvoice(admin, {
    organizationId: job.organization_id,
    projectId,
  });

  if (!result.ok) {
    // CONFLICT (an incomplete profile the confirming function should have
    // ruled out) and NOT_FOUND (the project vanished) cannot be fixed by
    // retrying; INTERNAL (a read or write blip) can.
    const permanent = result.error.code !== 'INTERNAL';
    return { status: 'failed', permanent, detail: result.error.message };
  }

  if (result.data.outcome === 'skipped') {
    return { status: 'succeeded', outcome: 'skipped', detail: result.data.reason };
  }

  return {
    status: 'succeeded',
    outcome: result.data.outcome,
    detail:
      result.data.outcome === 'created'
        ? `M1 invoice ${result.data.number} raised automatically.`
        : `M1 invoice ${result.data.number} already existed.`,
    invoiceId: result.data.invoiceId,
  };
}

/**
 * `project.phase_four_completed` → auto-raise the M2 invoice — Finance §2,
 * §5. `docs/phase-4-gap-analysis.md` step 6.
 *
 * The identical shape `handleBillingModeConfirmed` uses for M1: every
 * decision lives in `generateM2Invoice`, this claims the job and translates
 * its outcome. `projects.complete_phase_four` emits the event with
 * `subject_id` set to the project, trusted the same way `handleHandoffBound`
 * and `handleInvoicePaid` already trust their own event's subject.
 */
export async function handlePhaseFourCompletedForFinance(admin: Admin, job: BillingModeJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const projectId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;

  if (!projectId) {
    return { status: 'failed', permanent: true, detail: 'the event named no project' };
  }

  const result = await generateM2Invoice(admin, {
    organizationId: job.organization_id,
    projectId,
  });

  if (!result.ok) {
    const permanent = result.error.code !== 'INTERNAL';
    return { status: 'failed', permanent, detail: result.error.message };
  }

  if (result.data.outcome === 'skipped') {
    return { status: 'succeeded', outcome: 'skipped', detail: result.data.reason };
  }

  return {
    status: 'succeeded',
    outcome: result.data.outcome,
    detail:
      result.data.outcome === 'created'
        ? `M2 invoice ${result.data.number} raised automatically.`
        : `M2 invoice ${result.data.number} already existed.`,
    invoiceId: result.data.invoiceId,
  };
}

/**
 * Q-PH56 — `project.phase_five_completed` → the M3 invoice,
 * `project.phase_six_completed` → the M4 invoice. The same shape as
 * `handlePhaseFourCompletedForFinance`: the decision lives in the service, this
 * claims the job and translates its outcome. `projects.complete_phase` emits
 * with `subject_id` set to the project.
 */
async function handleLaterPhaseCompleted(
  admin: Admin,
  job: BillingModeJob,
  label: 'M3' | 'M4',
  generate: typeof generateM3Invoice,
): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const projectId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;
  if (!projectId) return { status: 'failed', permanent: true, detail: 'the event named no project' };

  const result = await generate(admin, { organizationId: job.organization_id, projectId });
  if (!result.ok) return { status: 'failed', permanent: result.error.code !== 'INTERNAL', detail: result.error.message };
  if (result.data.outcome === 'skipped') return { status: 'succeeded', outcome: 'skipped', detail: result.data.reason };
  return {
    status: 'succeeded',
    outcome: result.data.outcome,
    detail: result.data.outcome === 'created' ? `${label} invoice ${result.data.number} raised automatically.` : `${label} invoice ${result.data.number} already existed.`,
    invoiceId: result.data.invoiceId,
  };
}

export function handlePhaseFiveCompletedForFinance(admin: Admin, job: BillingModeJob): Promise<HandlerResult> {
  return handleLaterPhaseCompleted(admin, job, 'M3', generateM3Invoice);
}

export function handlePhaseSixCompletedForFinance(admin: Admin, job: BillingModeJob): Promise<HandlerResult> {
  return handleLaterPhaseCompleted(admin, job, 'M4', generateM4Invoice);
}

/**
 * `invoice.issued` → carry the bill to the client — Phase 2 Finance §4.5.
 *
 * The decision to issue stays with the person who pressed Issue; this is the
 * consequence. Every rule lives in `deliverIssuedInvoice`: this claims the job
 * and translates its outcome. `finance.issue_invoice` emits the event with
 * `subject_id` set to the invoice, trusted the same way the other handlers
 * trust their event's subject — and re-read under the job's organization.
 *
 * A channel that CANNOT be attempted (no email configured, no address, no
 * thread, no consent) is `skipped` with its reason on the delivery row, not a
 * failure: retrying cannot fix it, and a retry loop would hide it. A channel
 * that was attempted and failed makes the job fail, so the runner retries it
 * with its backoff; the row says which channel and why.
 */
export async function handleInvoiceIssuedForDelivery(admin: Admin, job: BillingModeJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const invoiceId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;
  if (!invoiceId) return { status: 'failed', permanent: true, detail: 'the event named no invoice' };

  const { deliverIssuedInvoice } = await import('./invoice-delivery');
  const result = await deliverIssuedInvoice(admin, { organizationId: job.organization_id, invoiceId });
  if ('error' in result) return { status: 'failed', permanent: result.permanent, detail: result.error };

  const summary = result.outcomes.map((o) => `${o.channel}: ${o.result}${o.result === 'sent' ? '' : ` (${o.detail})`}`).join('; ');
  if (result.retry) return { status: 'failed', permanent: false, detail: summary.slice(0, 500) };
  return { status: 'succeeded', outcome: 'delivered', detail: summary.slice(0, 500) };
}

/**
 * `handover.accepted` → raise the free-maintenance ₹0 document — Finance §9.
 *
 * The client accepting the handover is Phase 7 completing. The subject is the
 * handover; the project is read from the ROW, org-scoped, never from the
 * event's payload. A project with no free-included plan has nothing to raise
 * and says so; a plan whose payment is not yet 100% verified is reported as a
 * named refusal (the door's own answer), because retrying cannot make money
 * arrive.
 */
export async function handleHandoverAcceptedForFinance(admin: Admin, job: BillingModeJob): Promise<HandlerResult> {
  const handoverId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;
  if (!handoverId) return { status: 'failed', permanent: true, detail: 'the event named no handover' };

  const { data: handover, error } = await admin
    .schema('projects')
    .from('handovers')
    .select('id, project_id')
    .eq('id', handoverId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (error) return { status: 'failed', permanent: false, detail: `could not read the handover: ${error.message}` };
  if (!handover) return { status: 'succeeded', outcome: 'gone', detail: 'the handover no longer exists' };

  const result = await generateFreeMaintenanceInvoices(admin, { organizationId: job.organization_id, projectId: handover.project_id });
  if (!result.ok) return { status: 'failed', permanent: result.error.code !== 'INTERNAL', detail: result.error.message };

  const { issued, alreadyIssued, refused } = result.data;
  if (issued + alreadyIssued + refused.length === 0) {
    return { status: 'succeeded', outcome: 'no_free_plan', detail: 'this project has no free-included maintenance' };
  }
  if (refused.length > 0) {
    await admin.schema('core').rpc('raise_alert', {
      p_organization_id: job.organization_id,
      p_source: 'finance',
      p_severity: 'warning',
      p_summary: `A project's handover was accepted but its free-maintenance document was not raised (${refused.join('; ')}). Free maintenance waits on 100% verified payment.`,
      p_fingerprint: `free-maintenance-refused:${handover.project_id}`,
    });
  }
  return {
    status: 'succeeded',
    outcome: issued > 0 ? 'issued' : refused.length > 0 ? 'refused' : 'already_issued',
    detail: `free-maintenance documents: ${issued} raised, ${alreadyIssued} already there${refused.length ? `, refused: ${refused.join('; ')}` : ''}`,
  };
}
