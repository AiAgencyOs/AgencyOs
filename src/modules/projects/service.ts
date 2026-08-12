import 'server-only';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { Json } from '@/lib/db/types';
import { err, ok, unreadable, type Result } from '@/lib/result';

import {
  addDeliverableSchema,
  submitDeliverableSchema,
  type AddDeliverableInput,
  type SubmitDeliverableInput,
  configurePaymentPlanSchema,
  setProjectStatusSchema,
  splitBudget,
  PROJECT_TRANSITIONS,
  type ConfigurePaymentPlanInput,
  type ProjectStatus,
  type SetProjectStatusInput,
} from './schema';
import type { BillableMilestone, MilestoneBillingSummary } from './types';

/**
 * Writes for the projects module — its only public surface.
 *
 * `project.write` gates the project itself and `milestone.write` the payment
 * plan, both existing capabilities. No new capability was invented: the roles
 * allowed to run delivery are exactly the roles that should be able to move a
 * project into onboarding and agree its milestones.
 */

/** Creates a project. Called by sales/service.ts on conversion, and directly. */
export async function createProject(input: {
  organizationId: string;
  clientAccountId: string;
  opportunityId?: string | null;
  name: string;
  budgetMinor?: number | null;
  currency?: string;
}): Promise<Result<{ projectId: string }>> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .insert({
      organization_id: input.organizationId,
      client_account_id: input.clientAccountId,
      opportunity_id: input.opportunityId ?? null,
      name: input.name,
      // Every project starts in planning. Onboarding is an explicit move a
      // human makes once kickoff actually begins.
      status: 'planning',
      currency: input.currency ?? 'INR',
      budget_minor: input.budgetMinor ?? null,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'createProject', detail: error?.message }),
    );
    // projects_opportunity_key: this deal has already been converted, by a
    // click that got here first (audit D9). Reported as a conflict the caller
    // can recognise rather than an internal error it cannot.
    if (error?.code === '23505' && error.message.includes('projects_opportunity_key')) {
      return err('CONFLICT', 'This deal has already been converted into a project.');
    }
    return err('INTERNAL', 'Could not create the project.');
  }

  await recordAudit({
    organizationId: input.organizationId,
    action: 'project.created',
    subjectType: 'project',
    subjectId: data.id,
    after: { name: input.name, clientAccountId: input.clientAccountId },
  });

  return ok({ projectId: data.id });
}

/** Moves a project through its lifecycle — including into onboarding. */
export async function setProjectStatus(
  input: SetProjectStatusInput,
): Promise<Result<{ status: ProjectStatus }>> {
  const parsed = setProjectStatusSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid project status.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to change project status.');
  }

  const supabase = await createClient();

  const { data: project, error: readError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, status, organization_id')
    .eq('id', parsed.data.projectId)
    .is('deleted_at', null)
    .maybeSingle();

  if (readError) return err('INTERNAL', 'Could not load the project.');
  if (!project) return err('NOT_FOUND', 'Project not found.');

  const from = project.status as ProjectStatus;
  const to = parsed.data.status;

  if (from === to) return ok({ status: to });
  if (!PROJECT_TRANSITIONS[from]?.includes(to)) {
    return err('CONFLICT', `A project cannot move from ${from} to ${to}.`);
  }

  // The predicate the decision was made against, restated in the write (audit
  // D10). Reading the state and then matching on the id alone means a
  // concurrent transition is silently overwritten — the same shape D1, D2 and
  // D4 fixed in finance, where the answer was a lock. Here a compare-and-swap
  // is enough: there is no ledger to sum, only a state to not clobber, and a
  // write that matches zero rows says the world moved.
  const { data: moved, error } = await supabase
    .schema('projects')
    .from('projects')
    .update({
      status: to,
      ...(to === 'completed' ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq('id', project.id)
    .eq('status', from)
    .select('id')
    .maybeSingle();

  if (error) return err('INTERNAL', 'Could not update the project.');

  if (!moved) {
    return err(
      'CONFLICT',
      'This project was changed by somebody else while you were working. Reload and try again.',
    );
  }

  await recordAudit({
    organizationId: project.organization_id,
    action: 'project.status_changed',
    subjectType: 'project',
    subjectId: project.id,
    before: { status: from },
    after: { status: to },
  });

  return ok({ status: to });
}

/**
 * Replaces the project's payment plan.
 *
 * Written as delete-then-insert rather than a diff: a plan is negotiated as a
 * whole, and reconciling row-by-row against an edited split is a lot of
 * machinery for no business meaning.
 *
 * The insert is a single call so all rows land in one transaction — which is
 * what lets the deferred constraint trigger check the 100% total once at
 * commit rather than rejecting the first row it sees.
 *
 * Milestones that have already been met are refused, because re-pricing work a
 * client has signed off on is a billing dispute, not an edit.
 */
export async function configurePaymentPlan(
  input: ConfigurePaymentPlanInput,
): Promise<Result<{ milestones: number }>> {
  const parsed = configurePaymentPlanSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid payment plan.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to configure payment plans.');
  }

  const supabase = await createClient();

  // Everything below is one statement. The plan used to be read, checked,
  // deleted and re-inserted across four round trips — so a rewrite could
  // delete milestones that already carried issued invoices (unhooking the
  // bill and re-arming the milestone for a second one), and a rejected insert
  // left the project with no plan at all.
  const { data: project } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, organization_id, budget_minor')
    .eq('id', parsed.data.projectId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!project) return err('NOT_FOUND', 'Project not found.');

  const amounts = splitBudget(project.budget_minor ?? 0, parsed.data.items.map((i) => i.percent));

  const { data: replaced, error } = await supabase.schema('projects').rpc('replace_payment_plan', {
    p_project_id: project.id,
    p_milestones: parsed.data.items.map((item, index) => ({
      name: item.name,
      percent: item.percent,
      amountMinor: amounts[index] ?? 0,
      dueOn: item.dueOn ?? null,
    })) as unknown as Json,
  });

  if (error) {
    // The deferred trigger surfaces a plan that does not total 100 here, and
    // rolls the delete back with it — so the previous plan is still there.
    console.error(
      JSON.stringify({ level: 'error', scope: 'configurePaymentPlan', detail: error.message }),
    );
    if (error.message.includes('must total 100 percent')) {
      return err('VALIDATION', 'A payment plan must total exactly 100%.');
    }
    return err('INTERNAL', 'Could not save the payment plan.');
  }

  const settled = (Array.isArray(replaced) ? replaced[0] : replaced) as
    | { outcome: string; milestone_count: number | null; blocking_number: string | null }
    | undefined;
  if (!settled) return err('INTERNAL', 'Could not save the payment plan.');

  if (settled.outcome !== 'replaced') {
    if (settled.outcome === 'not_found') return err('NOT_FOUND', 'Project not found.');
    if (settled.outcome === 'met') {
      return err(
        'CONFLICT',
        'This project already has a met milestone. Its payment plan can no longer be replaced.',
      );
    }
    if (settled.outcome === 'billed') {
      return err(
        'CONFLICT',
        `Invoice ${settled.blocking_number} has already been raised against this plan. Void it before changing the plan.`,
      );
    }
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'configurePaymentPlan',
        detail: `unrecognised outcome "${settled.outcome}"`,
      }),
    );
    return err('INTERNAL', 'Could not save the payment plan.');
  }

  // The audit row is written by projects.replace_payment_plan, in the
  // transaction that replaced the plan (gap G-079). The budget it records comes
  // from the same locked read the function decides on, rather than from the
  // unlocked one taken out here before it.

  return ok({ milestones: settled.milestone_count ?? parsed.data.items.length });
}

/**
 * A milestone with its project context, for a module that needs to bill it.
 *
 * A read living in service.ts rather than queries.ts because it is the
 * *cross-module* surface: finance may not import projects/queries.ts
 * (ARCHITECTURE.md §3.2, enforced by eslint), and it should not be reading
 * projects' tables itself either. This is the one shape delivery is willing to
 * expose for billing, and it is deliberately narrow.
 *
 * No capability check here on purpose. Reads are scoped by RLS regardless of
 * caller, and the capability that matters — may this person raise an invoice —
 * belongs to the module doing the raising, checked once, where it means
 * something. Adding a second unrelated check here would only make the error
 * message wrong.
 */
export async function getBillableMilestone(
  milestoneId: string,
): Promise<Result<BillableMilestone>> {
  const supabase = await createClient();

  const { data: milestone, error } = await supabase
    .schema('projects')
    .from('milestones')
    .select(
      'id, organization_id, project_id, name, description, position, status, payment_percent, amount_minor, currency, due_on',
    )
    .eq('id', milestoneId)
    .maybeSingle();

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'getBillableMilestone', detail: error.message }),
    );
    return err('INTERNAL', 'Could not load the milestone.');
  }
  if (!milestone) return err('NOT_FOUND', 'Milestone not found.');

  const { data: project } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, status, client_account_id')
    .eq('id', milestone.project_id)
    .is('deleted_at', null)
    .maybeSingle();

  if (!project) return err('NOT_FOUND', 'The milestone belongs to a project that no longer exists.');

  return ok({
    milestoneId: milestone.id,
    organizationId: milestone.organization_id,
    projectId: milestone.project_id,
    clientAccountId: project.client_account_id,
    name: milestone.name,
    description: milestone.description,
    position: milestone.position,
    status: milestone.status,
    // numeric(5,2) arrives as a number through PostgREST, but a string is a
    // legitimate representation for it — normalise once, here, rather than
    // leaving every consumer to wonder.
    paymentPercent: milestone.payment_percent === null ? null : Number(milestone.payment_percent),
    amountMinor: milestone.amount_minor,
    currency: milestone.currency,
    dueOn: milestone.due_on,
    projectName: project.name,
    projectStatus: project.status,
  });
}

/** A project's milestones in plan order — the ordering the unlock rule reads. */
export async function listMilestonesForBilling(
  projectId: string,
): Promise<MilestoneBillingSummary[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('milestones')
    .select('id, name, position, payment_percent, amount_minor, currency')
    .eq('project_id', projectId)
    .order('position', { ascending: true });

  // The unlock rule is derived from this list, so an empty one because the
  // read failed is a plan that looks finished (gap G-054). It throws for the
  // same reason every other reader now does; the one caller that cannot let
  // an exception escape catches it and answers with a Result.
  if (error) unreadable('listMilestonesForBilling', error);
  return data ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════
// Deliverables — Phase 12
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add the next version of something the client will see.
 *
 * Never an edit. Directive §35: an approval names a version, so a revision is
 * a new row and the old one stays as the record of what was shown and what
 * was said about it. The version number is allocated in Postgres under the
 * project's lock, because two people uploading at the same moment must not
 * both become v3.
 */
export async function addDeliverable(
  input: AddDeliverableInput,
): Promise<Result<{ deliverableId: string; version: number }>> {
  const parsed = addDeliverableSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That deliverable could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to add deliverables.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('projects').rpc('add_deliverable', {
    p_project_id: parsed.data.projectId,
    p_kind: parsed.data.kind,
    p_title: parsed.data.title,
    ...(parsed.data.artifactUrl ? { p_artifact_url: parsed.data.artifactUrl } : {}),
    ...(parsed.data.changelog ? { p_changelog: parsed.data.changelog } : {}),
    ...(parsed.data.knownIssues ? { p_known_issues: parsed.data.knownIssues } : {}),
    ...(context.userId ? { p_created_by: context.userId } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addDeliverable', detail: error.message }));
    return err('INTERNAL', 'Could not add the deliverable.');
  }

  const settled = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; deliverable_id: string | null; version: number | null }
    | undefined;

  if (!settled) return err('INTERNAL', 'Could not add the deliverable.');
  if (settled.outcome === 'not_found') return err('NOT_FOUND', 'Project not found.');
  if (!settled.deliverable_id || settled.version === null) {
    return err('INTERNAL', 'Could not add the deliverable.');
  }

  return ok({ deliverableId: settled.deliverable_id, version: settled.version });
}

/**
 * Put it in front of the client.
 *
 * The review itself is the approval engine's — `submit_deliverable` raises a
 * request with `subject_type = 'deliverable'` and `audience = 'client'`, which
 * is the subject type the engine has carried since it was built with nothing
 * calling it. ADM-08d then applies: whoever records the client's answer must
 * say where the client gave it.
 *
 * A deliverable with no approval policy behind it is refused rather than
 * submitted. A review nobody is named to answer is a promise to the client
 * that the system cannot keep.
 */
export async function submitDeliverable(
  input: SubmitDeliverableInput,
): Promise<Result<{ requestId: string; status: string; alreadyInReview: boolean }>> {
  const parsed = submitDeliverableSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That submission could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to submit deliverables.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('projects').rpc('submit_deliverable', {
    p_deliverable_id: parsed.data.deliverableId,
    ...(context.userId ? { p_requested_by: context.userId } : {}),
    ...(parsed.data.summary ? { p_summary: parsed.data.summary } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'submitDeliverable', detail: error.message }));
    return err('INTERNAL', 'Could not submit the deliverable.');
  }

  const settled = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; request_id: string | null; status: string | null }
    | undefined;

  if (!settled) return err('INTERNAL', 'Could not submit the deliverable.');

  switch (settled.outcome) {
    case 'submitted':
    case 'already_in_review':
      if (!settled.request_id) return err('INTERNAL', 'Could not submit the deliverable.');
      return ok({
        requestId: settled.request_id,
        status: settled.status ?? 'in_review',
        alreadyInReview: settled.outcome === 'already_in_review',
      });

    case 'not_found':
      return err('NOT_FOUND', 'Deliverable not found.');

    case 'settled':
      return err('CONFLICT', `This version is already ${settled.status}.`);

    case 'no_policy':
      return err(
        'CONFLICT',
        'No approval policy covers deliverables, so nobody would be named to review this. An owner sets one first.',
      );

    default:
      return err('INTERNAL', 'Could not submit the deliverable.');
  }
}

/** Bring the client's decision back onto the deliverable after it is settled. */
export async function syncDeliverableDecision(deliverableId: string): Promise<Result<{ status: string }>> {
  await requireInternal();

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .rpc('sync_deliverable_decision', { p_deliverable_id: deliverableId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'syncDeliverableDecision', detail: error.message }));
    return err('INTERNAL', 'Could not read the decision.');
  }

  return ok({ status: String(data) });
}
