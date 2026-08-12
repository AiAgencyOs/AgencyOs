import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { ok } from '@/lib/result';
import { nextUnlockedMilestoneForProject } from '@/modules/finance/service';

import {
  invoicePaidEventSchema,
  invoicePaidVerdict,
  type InvoicePaidFacts,
} from './schema';

/**
 * Job handlers for the projects module.
 *
 * A file of its own rather than more of service.ts, because these run under a
 * fundamentally different principal. service.ts is session-bound: it calls
 * `requireInternal()`, checks a capability, and lets RLS scope every read. A
 * job handler has no session at all — it runs behind the cron-authenticated
 * runner on the service-role client, which bypasses RLS entirely.
 *
 * Keeping the two apart is the point. If the admin client were imported into
 * service.ts it would sit one import away from every Server Action, and
 * ARCHITECTURE.md §7.3 permits it in exactly four places. Here the boundary is
 * visible: **every query below scopes by organization_id by hand**, and the
 * organization comes from the job row — never from the event payload, which is
 * the untrusted part.
 *
 * The runner is the only caller. Handlers are addressed through
 * lib/events/catalog.ts (`projects:unlockNextMilestone`), not imported by name
 * from anywhere else.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type HandlerResult =
  | {
      status: 'succeeded';
      /** Machine-readable: 'unlocked' | 'already_unlocked' | 'nothing_to_unlock'. */
      outcome: string;
      detail: string;
      milestoneId?: string;
    }
  | {
      status: 'failed';
      /** True when retrying cannot possibly help — the runner parks the job. */
      permanent: boolean;
      detail: string;
    };

/** The envelope lib/events/dispatch.ts writes into core.jobs.payload. */
type JobEnvelope = {
  eventId?: number;
  eventType?: string;
  subjectType?: string | null;
  subjectId?: string | null;
  event?: unknown;
};

export type UnlockJob = {
  id: string;
  organization_id: string;
  payload: JobEnvelope | null;
  correlation_id: string | null;
};

/**
 * `invoice.paid` → open the next milestone.
 *
 * The last step of the revenue path: a client's payment is recorded, the
 * invoice becomes paid, finance publishes the fact, and delivery reacts. This
 * is the only place that reaction happens, and it does exactly one thing —
 * move one milestone from `pending` to `in_progress`.
 *
 * What it deliberately does not do: create a milestone, mark one paid, skip
 * one, touch the project's own status, or contact anything outside the
 * database. `invoicePaidVerdict` holds the whole rule and is pure; this
 * function gathers the facts it judges and applies its answer.
 *
 * Idempotency has three independent layers, because delivery is at-least-once
 * and only one of them is under this function's control:
 *
 *   1. `outbox_events.published_at` — an event is dispatched once per pass.
 *   2. `jobs.dedupe_key` (`evt:<id>:<handler>`) — re-dispatch enqueues nothing.
 *   3. the `status = 'pending'` predicate on the UPDATE below — if the same job
 *      somehow runs twice, the second update matches no row and reports
 *      `already_unlocked` rather than acting again.
 *
 * The third is the one that matters, because it holds even if the first two
 * are bypassed entirely: a milestone that is already in_progress, submitted or
 * met is left exactly as it is.
 */
export async function handleInvoicePaid(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const invoiceId = envelope.subjectId ?? null;

  const parsed = invoicePaidEventSchema.safeParse(envelope.event);
  if (!parsed.success) {
    return {
      status: 'failed',
      permanent: true,
      detail: `malformed invoice.paid payload: ${parsed.error.issues[0]?.message ?? 'unparseable'}`,
    };
  }
  const event = parsed.data;

  // ── the invoice, scoped to the job's organization ───────────────────────
  // The organization predicate is the isolation boundary. Under the service
  // role there is no RLS to fall back on, so an event that names another
  // tenant's invoice simply finds nothing here.
  const invoice = invoiceId
    ? await loadInvoice(admin, { invoiceId, organizationId: job.organization_id })
    : null;

  // ── the target milestone, likewise scoped ───────────────────────────────
  const target = event.unlockedMilestoneId
    ? await loadMilestone(admin, {
        milestoneId: event.unlockedMilestoneId,
        organizationId: job.organization_id,
      })
    : null;

  // ── what the *live* plan says comes next ────────────────────────────────
  // Recomputed rather than trusted. Between publishing and handling, the
  // invoice may have been voided, the plan re-cut, or a later milestone opened
  // by hand; the event is a pointer to facts, not the facts.
  const plan = event.projectId
    ? await nextUnlockedMilestoneForProject(admin, {
        organizationId: job.organization_id,
        projectId: event.projectId,
      })
    : ok(null);

  // A plan that could not be read is a reason to try again, not a reason to
  // decide (audit D5). Every refusal below is `permanent: true`, which parks
  // the job as dead on its first attempt — so handing this verdict an empty
  // plan because a query blipped strands a milestone the client has paid for,
  // and nothing ever retries it. Bailing here keeps the job queued.
  if (!plan.ok) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'handleInvoicePaid',
        jobId: job.id,
        organizationId: job.organization_id,
        detail: plan.error.message,
      }),
    );
    return { status: 'failed', permanent: false, detail: plan.error.message };
  }

  // A loader that could not read is the same kind of answer as a plan that
  // could not be read: retryable, not a verdict (audit D15). `undefined` is
  // the read failing; `null` is the row genuinely absent, which the verdict
  // refuses permanently and rightly.
  if (invoice === undefined || target === undefined) {
    const detail = 'the invoice or milestone could not be read';
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'handleInvoicePaid',
        jobId: job.id,
        organizationId: job.organization_id,
        detail,
      }),
    );
    return { status: 'failed', permanent: false, detail };
  }

  const intendedNextMilestoneId = plan.data;

  const facts: InvoicePaidFacts = {
    jobOrganizationId: job.organization_id,
    invoiceId,
    event,
    invoice,
    target,
    intendedNextMilestoneId,
  };

  const verdict = invoicePaidVerdict(facts);

  if (verdict.outcome === 'refuse') {
    // Refusals are not audited. They are recorded on the job (`last_error`,
    // status `dead`) and logged structurally, which is observable and
    // bounded — whereas audit.audit_log is append-only and undeletable, so a
    // replayed bad event would write history nobody can ever clear.
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'handleInvoicePaid',
        jobId: job.id,
        eventId: envelope.eventId ?? null,
        organizationId: job.organization_id,
        detail: verdict.reason,
      }),
    );
    return { status: 'failed', permanent: verdict.permanent, detail: verdict.reason };
  }

  if (verdict.outcome === 'nothing_to_unlock') {
    // Requirement of the flow, stated plainly: when the plan is finished there
    // is no next milestone to invent, and no project status in this system
    // means "fully paid but not yet delivered" — `completed` means delivered.
    // So the project is left exactly as it is and the gap is recorded rather
    // than papered over with a state that would be a lie.
    await writeAudit(admin, {
      organizationId: job.organization_id,
      action: 'milestone.unlock_skipped',
      subjectType: 'invoice',
      subjectId: invoiceId,
      after: {
        reason: verdict.reason,
        projectId: event.projectId,
        milestoneId: event.milestoneId,
        projectStatusChanged: false,
      },
      correlationId: job.correlation_id,
    });

    return { status: 'succeeded', outcome: 'nothing_to_unlock', detail: verdict.reason };
  }

  if (verdict.outcome === 'already_unlocked') {
    return {
      status: 'succeeded',
      outcome: 'already_unlocked',
      detail: `milestone is already ${verdict.status}`,
      milestoneId: verdict.milestoneId,
    };
  }

  // ── the one write ───────────────────────────────────────────────────────
  // Every predicate re-states a fact the verdict already checked. That is not
  // redundancy: the verdict judged a snapshot, and this makes the write itself
  // conditional on the snapshot still holding.
  const { data: unlocked, error } = await admin
    .schema('projects')
    .from('milestones')
    .update({ status: 'in_progress' })
    .eq('id', verdict.milestoneId)
    .eq('organization_id', job.organization_id)
    .eq('project_id', event.projectId ?? '')
    .eq('status', 'pending')
    .select('id, status')
    .maybeSingle();

  if (error) {
    // Transient by default: a failed UPDATE is worth retrying, and the
    // predicates above make the retry safe.
    return { status: 'failed', permanent: false, detail: `unlock failed: ${error.message}` };
  }

  if (!unlocked) {
    // Zero rows means another delivery won the race between the read and the
    // write. The desired state holds either way, so this is a success — but it
    // is reported as `already_unlocked`, never as a fresh unlock, because
    // claiming to have done something this call did not do is exactly the
    // failure mode worth avoiding.
    return {
      status: 'succeeded',
      outcome: 'already_unlocked',
      detail: 'milestone was unlocked concurrently',
      milestoneId: verdict.milestoneId,
    };
  }

  await writeAudit(admin, {
    organizationId: job.organization_id,
    action: 'milestone.unlocked',
    subjectType: 'milestone',
    subjectId: verdict.milestoneId,
    before: { status: 'pending' },
    after: {
      status: 'in_progress',
      unlockedBy: 'invoice.paid',
      invoiceId,
      eventId: envelope.eventId ?? null,
      projectId: event.projectId,
      paidMilestoneId: event.milestoneId,
    },
    correlationId: job.correlation_id,
  });

  return {
    status: 'succeeded',
    outcome: 'unlocked',
    detail: 'milestone moved from pending to in_progress',
    milestoneId: verdict.milestoneId,
  };
}

// ── reads ──────────────────────────────────────────────────────────────────

/**
 * A failed read here is not an invoice that does not exist (audit D15).
 *
 * Both loaders returned null for "absent" and for "the database did not
 * answer", and invoicePaidVerdict refuses a missing invoice with
 * `permanent: true` — so the runner parked the job dead on its first attempt.
 * A transient blip permanently stranded a milestone the client had paid for,
 * which is exactly D5 one function along, in the loaders rather than the plan
 * read.
 *
 * `undefined` means the read failed; `null` still means genuinely absent.
 */
async function loadInvoice(
  admin: Admin,
  scope: { invoiceId: string; organizationId: string },
): Promise<InvoicePaidFacts['invoice'] | undefined> {
  const { data, error } = await admin
    .schema('finance')
    .from('invoices')
    .select('id, organization_id, project_id, milestone_id, status, paid_minor, total_minor')
    .eq('id', scope.invoiceId)
    .eq('organization_id', scope.organizationId)
    .maybeSingle();

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'handleInvoicePaid.loadInvoice', detail: error.message }),
    );
    return undefined;
  }
  if (!data) return null;

  return {
    id: data.id,
    organizationId: data.organization_id,
    projectId: data.project_id,
    milestoneId: data.milestone_id,
    status: data.status,
    paidMinor: data.paid_minor,
    totalMinor: data.total_minor,
  };
}

async function loadMilestone(
  admin: Admin,
  scope: { milestoneId: string; organizationId: string },
): Promise<InvoicePaidFacts['target'] | undefined> {
  const { data, error } = await admin
    .schema('projects')
    .from('milestones')
    .select('id, organization_id, project_id, status')
    .eq('id', scope.milestoneId)
    .eq('organization_id', scope.organizationId)
    .maybeSingle();

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'handleInvoicePaid.loadMilestone', detail: error.message }),
    );
    return undefined;
  }
  if (!data) return null;

  return {
    id: data.id,
    organizationId: data.organization_id,
    projectId: data.project_id,
    status: data.status,
  };
}

/**
 * Appends to audit.audit_log as the system.
 *
 * lib/audit.ts cannot serve here: it reads the actor from the session, and
 * there is no session behind cron. `actor_type = 'system'` is already part of
 * the table's CHECK, so this records the runner honestly as the actor rather
 * than attributing an automated transition to whoever happened to click
 * "record payment" minutes earlier.
 *
 * Failure is logged, never fatal — the milestone has already moved, and
 * refusing a committed state change because its history row would not insert
 * is the wrong trade. Same reasoning as lib/audit.ts.
 */
async function writeAudit(
  admin: Admin,
  entry: {
    organizationId: string;
    action: string;
    subjectType: string;
    subjectId: string | null;
    before?: unknown;
    after?: unknown;
    correlationId: string | null;
  },
): Promise<void> {
  const { error } = await admin
    .schema('audit')
    .from('audit_log')
    .insert({
      organization_id: entry.organizationId,
      actor_type: 'system',
      actor_id: null,
      action: entry.action,
      subject_type: entry.subjectType,
      subject_id: entry.subjectId,
      before: (entry.before ?? null) as never,
      after: (entry.after ?? null) as never,
      correlation_id: entry.correlationId,
    });

  if (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'handleInvoicePaid.audit',
        action: entry.action,
        detail: error.message,
      }),
    );
  }
}
