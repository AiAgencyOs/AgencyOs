import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { generateFirstMilestoneInvoice, generateM2Invoice } from './service';

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
