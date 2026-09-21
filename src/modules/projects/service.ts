import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { Json } from '@/lib/db/types';
import { err, ok, type Result } from '@/lib/result';

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
  startProjectSchema,
  type StartProjectInput,
  reviseGroupSetupSchema,
  confirmGroupCreatedSchema,
  mapGroupSchema,
  verifyGroupSchema,
  type ReviseGroupSetupInput,
  type ConfirmGroupCreatedInput,
  type MapGroupInput,
  type VerifyGroupInput,
  createModuleSchema,
  createFeatureSchema,
  createTaskSchema,
  setModuleStatusSchema,
  setFeatureStatusSchema,
  setTaskStatusSchema,
  type CreateModuleInput,
  type CreateFeatureInput,
  type CreateTaskInput,
  type SetModuleStatusInput,
  type SetFeatureStatusInput,
  type SetTaskStatusInput,
  openScopeVersionSchema,
  addScopeItemSchema,
  removeScopeItemSchema,
  freezeScopeVersionSchema,
  type OpenScopeVersionInput,
  type AddScopeItemInput,
  type RemoveScopeItemInput,
  type FreezeScopeVersionInput,
} from './schema';
import type { BillableMilestone } from './types';
import { LOCKED_PAYMENT_STRUCTURE, lockedAmountsFor } from './payment-structure';
import { resolveOnboardingContext, type ContextMatrix } from './onboarding-context';

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
  /**
   * The accepted quotation this project is being raised from — Document 10
   * §7's "Accepted quote/version", G-017.
   *
   * Optional and never demanded. §2 says a project should not be created
   * without commercial acceptance; ADM-13 answered the adjacent question and
   * did **not** put an accepted quotation among the three conditions for a
   * project to start, and every project raised before quotations existed has
   * none. ADM-72 asks whether it should become a fourth.
   */
  proposalId?: string | null;
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
      proposal_id: input.proposalId ?? null,
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
 * Install the locked payment structure on a project — ADM-105, Finance §2.
 *
 * Called when Phase 2 starts, by the runner, as the service role. It writes
 * through `projects.replace_payment_plan` — the same door a person uses, the
 * only insert path into `projects.milestones`, with the deferred trigger that
 * refuses a plan not totalling 100 and the guards that refuse a plan already
 * met or already billed.
 *
 * **It never replaces a plan somebody configured.** `replace_payment_plan`
 * does what its name says, and calling it on a project that already has
 * milestones would silently overwrite a person's judgement with a default —
 * the one thing a "locked standard structure" must not do. So the absence of
 * any milestone is the precondition, checked here and answered by name.
 *
 * A project with no budget is refused rather than given four milestones of
 * zero: a payment plan whose rows are all nothing looks configured and bills
 * nobody, and the budget is a fact somebody has to supply.
 */
export async function installLockedPaymentStructure(
  projectId: string,
  /**
   * The client to write through. The runner passes its admin client because a
   * job has no session; a person's path would pass theirs. Explicit rather
   * than defaulted, so nobody installs a structure with the wrong authority by
   * forgetting an argument.
   */
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<Result<{ milestones: number; installed: boolean; reason?: string }>> {

  const { data: project, error: readError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, organization_id, budget_minor')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle();

  // A read that failed is not a project that is absent (G-054).
  if (readError) return err('INTERNAL', 'Could not read the project.');
  if (!project) return err('NOT_FOUND', 'Project not found.');

  const { data: existing, error: existingError } = await supabase
    .schema('projects')
    .from('milestones')
    .select('id')
    .eq('project_id', projectId)
    .limit(1);
  if (existingError) return err('INTERNAL', 'Could not read the project’s milestones.');
  if ((existing?.length ?? 0) > 0) {
    return ok({ milestones: 0, installed: false, reason: 'a payment plan already exists and was left alone' });
  }

  if (!project.budget_minor || project.budget_minor <= 0) {
    return ok({
      milestones: 0,
      installed: false,
      reason: 'the project has no budget, and four milestones of zero would look configured while billing nobody',
    });
  }

  const amounts = lockedAmountsFor(project.budget_minor);
  const { data: replaced, error } = await supabase.schema('projects').rpc('replace_payment_plan', {
    p_project_id: project.id,
    p_milestones: LOCKED_PAYMENT_STRUCTURE.map((milestone, index) => ({
      name: milestone.name,
      percent: milestone.percent,
      amountMinor: amounts[index] ?? 0,
      dueOn: null,
    })) as unknown as Json,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'installLockedPaymentStructure', detail: error.message }));
    return err('INTERNAL', 'Could not install the locked payment structure.');
  }

  const settled = (Array.isArray(replaced) ? replaced[0] : replaced) as
    | { outcome: string; milestone_count: number | null }
    | undefined;
  if (settled?.outcome !== 'replaced') {
    return err('INTERNAL', `the payment-plan door answered ${settled?.outcome ?? 'nothing'}`);
  }

  return ok({ milestones: settled.milestone_count ?? LOCKED_PAYMENT_STRUCTURE.length, installed: true });
}

/**
 * Read what Phase 1 left, and work out what is still worth asking — PM §4.1.
 *
 * Every read here is a REFERENCE the handoff packet already holds, followed
 * home. Nothing is copied into a Phase 2 table: the packet names rows, the rows
 * are the facts, and a snapshot of them would be a second source that drifts —
 * the same reasoning `projects.phase_two` was built on (G-250).
 *
 * The packet's own `unresolved` list is read verbatim and treated as
 * authoritative for the fields it names. It was computed at the win, which is
 * when those things were true, and re-deriving them here would be a second
 * opinion about a settled question.
 *
 * A read that fails is not a fact that is absent (G-054), so every failure
 * returns rather than being folded into `missing` — a resolver that turns a
 * dropped connection into "the client never told us" would have the PM ask a
 * paying client to repeat themselves because a query timed out.
 */
export async function resolveProjectContext(
  projectId: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<Result<ContextMatrix>> {
  const { data: project, error: projectError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, client_account_id, proposal_id')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle();
  if (projectError) return err('INTERNAL', 'Could not read the project.');
  if (!project) return err('NOT_FOUND', 'Project not found.');

  const { data: handoff, error: handoffError } = await supabase
    .schema('ai')
    .from('handoffs')
    .select('id, unresolved, context, artifacts, requirements')
    .eq('project_id', projectId)
    .eq('from_agent', 'sales')
    .eq('to_agent', 'project_manager')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (handoffError) return err('INTERNAL', 'Could not read the handoff packet.');
  if (!handoff) return err('NOT_FOUND', 'This project has no WON handoff packet.');

  const packetContext = (handoff.context ?? {}) as Record<string, unknown>;
  const contactId = typeof packetContext.contact_id === 'string' ? packetContext.contact_id : null;
  const leadId = typeof packetContext.lead_id === 'string' ? packetContext.lead_id : null;
  const conversationId = typeof packetContext.conversation_id === 'string' ? packetContext.conversation_id : null;
  const requirementRef = (Array.isArray(handoff.requirements) ? handoff.requirements[0] : null) as
    | { requirement_version_id?: string }
    | null;
  const proposalRef = (Array.isArray(handoff.artifacts) ? handoff.artifacts[0] : null) as
    | { proposal_id?: string }
    | null;
  const proposalId =
    project.proposal_id ?? (typeof proposalRef?.proposal_id === 'string' ? proposalRef.proposal_id : null);
  const requirementId =
    typeof requirementRef?.requirement_version_id === 'string' ? requirementRef.requirement_version_id : null;

  const [contactRead, accountRead, proposalRead, requirementRead, latestRead, scopeRead, coverageRead] =
    await Promise.all([
      contactId
        ? supabase.schema('crm').from('contacts').select('id, full_name').eq('id', contactId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      project.client_account_id
        ? supabase.schema('core').from('client_accounts').select('id, name').eq('id', project.client_account_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      proposalId
        ? supabase.schema('sales').from('proposals').select('id, version, status').eq('id', proposalId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      requirementId
        ? supabase.schema('crm').from('requirement_versions').select('id, version, status').eq('id', requirementId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      conversationId
        ? supabase
            .schema('crm')
            .from('requirement_versions')
            .select('id, version')
            .eq('conversation_id', conversationId)
            .eq('status', 'accepted')
            .order('version', { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .schema('projects')
        .from('scope_versions')
        .select('id, version, status')
        .eq('project_id', projectId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle(),
      leadId
        ? supabase.schema('crm').from('qualification_coverage').select('area, quote').eq('lead_id', leadId)
        : Promise.resolve({ data: [], error: null }),
    ]);

  for (const read of [contactRead, accountRead, proposalRead, requirementRead, latestRead, scopeRead, coverageRead]) {
    if (read.error) return err('INTERNAL', 'Could not read the inherited Phase 1 context.');
  }

  const coverage: Record<string, { quote: string }> = {};
  for (const row of (coverageRead.data ?? []) as Array<{ area: string; quote: string }>) {
    coverage[row.area] = { quote: row.quote };
  }

  return ok(
    resolveOnboardingContext({
      unresolved: Array.isArray(handoff.unresolved) ? (handoff.unresolved as string[]) : [],
      contact: contactRead.data as { id: string; full_name: string | null } | null,
      clientAccount: accountRead.data as { id: string; name: string | null } | null,
      project: { id: project.id, name: project.name },
      proposal: proposalRead.data as { id: string; version: number | null; status: string | null } | null,
      requirement: requirementRead.data as { id: string; version: number | null; status: string | null } | null,
      latestAcceptedRequirement: latestRead.data as { id: string; version: number | null } | null,
      scope: scopeRead.data as { id: string; version: number | null; status: string | null } | null,
      coverage,
    }),
  );
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

/*
 * `listMilestonesForBilling` USED TO LIVE HERE, and it is deliberately gone —
 * G-306.
 *
 * It was a SECOND READER of `projects.milestones`, and `listPaymentPlan` in
 * `queries.ts` reads the same rows with a superset of the columns and has
 * callers. Its own comment still said *"the one caller that cannot let an
 * exception escape catches it"* — a claim that had gone false where somebody
 * reading it would take it as current.
 *
 * Two readers of one table is not the problem by itself; two readers where
 * only one is exercised is, because the unexercised one drifts and nothing
 * fails. The survivor is the one with callers.
 */


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

// ── onboarding (G-017, ADM-06) ─────────────────────────────────────────────
//
// Document 10 §6's checklist, and ADM-06's whole answer about it: **it blocks
// nothing.** Every item is a reminder. Nothing here is consulted by
// `startProject`, by the QA gate, or by anything else that refuses work — and
// that is deliberate rather than unfinished.

/**
 * Create the checklist for a project. Called by conversion; safe to re-run.
 *
 * Not a `Result` failure when it has already been seeded: a project that
 * already has its checklist is the outcome the caller wanted.
 */
export async function seedOnboarding(
  projectId: string,
): Promise<Result<{ items: number; alreadySeeded: boolean }>> {
  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to set up projects.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .rpc('seed_onboarding', { p_project_id: projectId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'seedOnboarding', detail: error.message }));
    return err('INTERNAL', 'Could not create the onboarding checklist.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome: 'seeded' | 'already_seeded' | 'not_found'; items: number | null }
    | undefined;

  if (!row) return err('INTERNAL', 'Could not create the onboarding checklist.');
  if (row.outcome === 'not_found') return err('NOT_FOUND', 'Project not found.');

  return ok({ items: row.items ?? 0, alreadySeeded: row.outcome === 'already_seeded' });
}

/** Tick, un-tick or excuse one checklist item. */
export async function setOnboardingItem(input: {
  itemId: string;
  /**
   * Master §5.4's four states, plus pending — G-261. `done` is gone: it was
   * migrated to `verified`, and the door refuses it, so a caller still sending
   * it learns immediately rather than writing a value nothing accepts.
   */
  status: 'pending' | 'waiting_client' | 'received' | 'verified' | 'not_applicable';
  note?: string;
}): Promise<Result<{ status: string; done: number; total: number }>> {
  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to update onboarding.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('projects').rpc('set_onboarding_item', {
    p_item_id: input.itemId,
    p_status: input.status,
    p_actor: context.userId,
    ...(input.note ? { p_note: input.note } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setOnboardingItem', detail: error.message }));
    return err('INTERNAL', 'Could not update the checklist.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: 'set' | 'not_found' | 'invalid_status';
        status: string | null;
        done: number | null;
        total: number | null;
      }
    | undefined;

  if (!row) return err('INTERNAL', 'Could not update the checklist.');

  switch (row.outcome) {
    case 'set':
      return ok({ status: row.status ?? input.status, done: row.done ?? 0, total: row.total ?? 0 });
    case 'not_found':
      return err('NOT_FOUND', 'Checklist item not found.');
    case 'invalid_status':
      return err('VALIDATION', 'A checklist item is pending, done, or not applicable.');
    default:
      return err('INTERNAL', 'Could not update the checklist.');
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

// ── officially starting ────────────────────────────────────────────────────

/** The row `projects.start_project` returns. */
type StartProjectRow = {
  outcome: 'started' | 'already_active' | 'not_found' | 'not_startable' | 'not_ready';
  project_status: string | null;
  unmet: string[] | null;
  overridden: boolean;
};

/** What each unmet condition means to somebody reading a screen. */
const UNMET_REASONS: Record<string, string> = {
  advance_not_verified: 'the advance payment has not been confirmed',
  no_approved_requirement: 'no requirement version has been approved',
  no_whatsapp_group: 'the project has no WhatsApp group',
};

export type ProjectStart = {
  status: string;
  started: boolean;
  overridden: boolean;
};

/**
 * ONBOARDING → ACTIVE. What "the project officially started" means — ADM-13.
 *
 * Three conditions, and they were written down on the first delivery migration
 * and enforced by nobody: the advance **verified** (not merely recorded — see
 * G-007), a requirement approved, and the WhatsApp group linked. Until this, a
 * project became active because somebody picked `active` from a dropdown.
 *
 * The owner may start one anyway. That is deliberate and it is why the reason
 * is required rather than optional: an exception nobody has to explain is not
 * an exception, it is the rule with extra steps.
 *
 * **Overriding is owner-only, and that is decided here.** The database enforces
 * that a reason was given; who is allowed to give one is a capability question,
 * and `organization.settings` is the capability that already means "change what
 * this agency does" — it resolves to the owner alone. Starting a project that
 * *is* ready needs only `project.write`, because it is not an exception at all.
 *
 * Nothing is decided from a read taken here. The conditions are evaluated under
 * the project's row lock inside `projects.start_project`, because a requirement
 * approved between this function's check and its write would otherwise be
 * either missed or double-counted — the shape D1, D2, D4 and D20 all were.
 */
export async function startProject(input: StartProjectInput): Promise<Result<ProjectStart>> {
  const parsed = startProjectSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid start request.');
  }

  const context = await requireInternal();

  const capability = parsed.data.overrideReason ? 'organization.settings' : 'project.write';
  if (!can(context.role, capability)) {
    return err(
      'FORBIDDEN',
      parsed.data.overrideReason
        ? 'Only the owner may start a project before it is ready.'
        : 'You do not have permission to start projects.',
    );
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('projects').rpc('start_project', {
    p_project_id: parsed.data.projectId,
    ...(parsed.data.overrideReason ? { p_override_reason: parsed.data.overrideReason } : {}),
  });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'startProject', detail: error.message }),
    );
    return err('INTERNAL', 'Could not start that project.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as StartProjectRow | undefined;

  // A read that returned nothing is a failed read, not an empty answer — G-054.
  if (!row) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'startProject', detail: 'no row returned' }),
    );
    return err('INTERNAL', 'Could not start that project.');
  }

  switch (row.outcome) {
    case 'started':
      return ok({ status: 'active', started: true, overridden: row.overridden });

    // Two people pressing the same button get the same picture.
    case 'already_active':
      return ok({ status: 'active', started: false, overridden: false });

    case 'not_found':
      return err('NOT_FOUND', 'That project is not in this organization.');

    case 'not_startable':
      return err(
        'CONFLICT',
        `A project is started from onboarding, and this one is ${row.project_status ?? 'elsewhere'}.`,
      );

    // Named rather than summarised. "The advance is not confirmed" and "nobody
    // has approved a requirement" are different problems, usually for different
    // people, and a single "not ready" tells neither of them what to do.
    case 'not_ready': {
      const reasons = (row.unmet ?? []).map((key) => UNMET_REASONS[key] ?? key);
      return err('CONFLICT', `This project is not ready to start: ${reasons.join(', ')}.`);
    }

    default:
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'startProject',
          detail: `unrecognised outcome "${String(row.outcome)}"`,
        }),
      );
      return err('INTERNAL', 'Could not start that project.');
  }
}

/**
 * The WhatsApp group manual action — Master §5.5, §6, §9; PM-04.
 *
 * **Every one of these is a person's click, and that is the point.** Meta
 * refused this deployment's WABA the Groups API (#131215, ADM-95), so the
 * group is made by a human in the ordinary app. What AgencyOS can do is
 * prepare the exact name and the exact member list, and then record honestly
 * what the person did — which is why `confirm`, `map` and `verify` all refuse
 * the service role at the door. An unattended process cannot witness something
 * that happened in another app, and Master §6's audit line asks *who
 * confirmed*.
 *
 * Nothing here calls a provider. If Meta ever grants Groups eligibility, the
 * four states and the snapshot survive unchanged and only the middle step
 * moves.
 */

type GroupDoor = { outcome: string };

/** Reads the single-row answer every door in this family returns. */
function groupOutcome(data: unknown): string {
  const row = (Array.isArray(data) ? data[0] : data) as GroupDoor | undefined;
  return row?.outcome ?? 'no answer';
}

/**
 * Raise the Admin's card — PM-04.
 *
 * Called by the runner when Phase 2 starts, and by a person repairing a card
 * that was never raised. Idempotent in the door, under the project's lock.
 */
export async function requestGroupSetup(
  projectId: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<Result<{ setupId: string | null; outcome: string }>> {
  const { data, error } = await supabase
    .schema('projects')
    .rpc('request_group_setup', { p_project_id: projectId } as never);
  if (error) return err('INTERNAL', `the group-setup door did not answer: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; setup_id?: string | null }
    | undefined;
  const outcome = row?.outcome ?? 'no answer';
  if (outcome !== 'requested' && outcome !== 'already_requested') {
    return err('INTERNAL', `the group-setup door answered ${outcome}`);
  }
  return ok({ setupId: row?.setup_id ?? null, outcome });
}

/** §6 — the name and the members are the Admin's until the group exists. */
export async function reviseGroupSetup(input: ReviseGroupSetupInput): Promise<Result<{ revised: true }>> {
  const parsed = reviseGroupSetupSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid revision.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to change a group setup.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('revise_group_setup', {
    p_setup_id: parsed.data.setupId,
    p_suggested_name: parsed.data.suggestedName,
    p_members: parsed.data.members as unknown as Json,
  });
  if (error) return err('INTERNAL', 'Could not revise the group setup.');

  switch (groupOutcome(data)) {
    case 'revised':
      return ok({ revised: true });
    case 'not_pending':
      return err('CONFLICT', 'This group has already been created, so its name and members are now a record rather than a plan.');
    case 'unknown_setup':
      return err('NOT_FOUND', 'Group setup not found.');
    case 'invalid_members':
      return err('VALIDATION', 'The member list must be a list.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change this group setup.');
  }
}

/** §6 "Confirm created" — a person says they made it. */
export async function confirmGroupCreated(input: ConfirmGroupCreatedInput): Promise<Result<{ state: 'created' }>> {
  const parsed = confirmGroupCreatedSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid confirmation.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to confirm a group.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('confirm_group_created', {
    p_setup_id: parsed.data.setupId,
    p_note: parsed.data.note,
  });
  if (error) return err('INTERNAL', 'Could not record the confirmation.');

  switch (groupOutcome(data)) {
    case 'confirmed':
      return ok({ state: 'created' });
    case 'already_confirmed':
      return err('CONFLICT', 'This group has already been confirmed.');
    case 'unknown_setup':
      return err('NOT_FOUND', 'Group setup not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to confirm this group.');
  }
}

/** §6 "Map/reference", §9 WhatsAppGroupMapped — a person says which group it is. */
export async function mapGroup(input: MapGroupInput): Promise<Result<{ state: 'mapped' }>> {
  const parsed = mapGroupSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid mapping.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to map a group.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('map_group', {
    p_setup_id: parsed.data.setupId,
    p_conversation_id: parsed.data.conversationId,
  });
  if (error) return err('INTERNAL', 'Could not map the group.');

  switch (groupOutcome(data)) {
    case 'mapped':
      return ok({ state: 'mapped' });
    case 'not_created':
      return err('CONFLICT', 'Confirm the group was created before mapping it.');
    case 'already_mapped':
      return err('CONFLICT', 'This group is already mapped.');
    case 'wrong_project':
      // Named rather than folded into NOT_FOUND: this is the mistake that
      // would send one client's invoices to another client's group.
      return err('CONFLICT', 'That conversation is not this project’s group.');
    case 'unknown_conversation':
      return err('NOT_FOUND', 'Conversation not found.');
    case 'unknown_setup':
      return err('NOT_FOUND', 'Group setup not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to map this group.');
  }
}

/** §9's fourth state — somebody has looked at the group and the right people are in it. */
export async function verifyGroup(input: VerifyGroupInput): Promise<Result<{ state: 'verified' }>> {
  const parsed = verifyGroupSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid verification.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to verify a group.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .rpc('verify_group', { p_setup_id: parsed.data.setupId });
  if (error) return err('INTERNAL', 'Could not verify the group.');

  switch (groupOutcome(data)) {
    case 'verified':
      return ok({ state: 'verified' });
    case 'already_verified':
      return err('CONFLICT', 'This group is already verified.');
    case 'not_mapped':
      return err('CONFLICT', 'Map the group to a conversation before verifying it.');
    case 'unknown_setup':
      return err('NOT_FOUND', 'Group setup not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to verify this group.');
  }
}

/**
 * The internal team roster — Master §6, P2-05; G-267.
 *
 * Every write goes through a door, because G-253 gave the table a SELECT
 * policy and nothing else. The doors refuse an unattended caller: a roster of
 * the agency's own people is not something a job should be editing.
 */

export async function addTeamDefault(input: {
  displayName: string;
  phone: string;
  role?: string;
  position?: number;
}): Promise<Result<{ memberId: string; added: boolean }>> {
  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to change the team roster.');
  }
  if (input.displayName.trim().length === 0) {
    return err('VALIDATION', 'Give the person a name — a number with nobody attached is not a member.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('add_team_default', {
    p_display_name: input.displayName,
    p_phone: input.phone,
    p_role: input.role,
    p_position: input.position,
  });
  if (error) return err('INTERNAL', 'Could not add the team member.');

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; member_id?: string | null }
    | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'added':
      return ok({ memberId: row!.member_id!, added: true });
    case 'already_listed':
      // Not an error: adding somebody already on the roster is not a mistake.
      return ok({ memberId: row!.member_id!, added: false });
    case 'invalid_phone':
      return err('VALIDATION', 'A WhatsApp number is 6–20 digits, optionally with a leading +.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change the team roster.');
  }
}

export async function setTeamDefaultActive(input: {
  memberId: string;
  active: boolean;
}): Promise<Result<{ changed: boolean }>> {
  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to change the team roster.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .rpc('set_team_default_active', { p_member_id: input.memberId, p_active: input.active });
  if (error) return err('INTERNAL', 'Could not update the team member.');

  switch ((Array.isArray(data) ? data[0] : data)?.outcome ?? 'no answer') {
    case 'set':
      return ok({ changed: true });
    case 'unchanged':
      return ok({ changed: false });
    case 'unknown_member':
      return err('NOT_FOUND', 'Team member not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change the team roster.');
  }
}

export async function removeTeamDefault(memberId: string): Promise<Result<{ removed: true }>> {
  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to change the team roster.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .rpc('remove_team_default', { p_member_id: memberId });
  if (error) return err('INTERNAL', 'Could not remove the team member.');

  switch ((Array.isArray(data) ? data[0] : data)?.outcome ?? 'no answer') {
    case 'removed':
      // Safe: a card's member list is a copy, so this cannot rewrite a group
      // that already exists (G-253).
      return ok({ removed: true });
    case 'unknown_member':
      return err('NOT_FOUND', 'Team member not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change the team roster.');
  }
}

/**
 * Phase 5 development breakdown — modules, features and tasks.
 *
 * `milestone.write` gates modules and features (owner, ops_admin,
 * delivery_lead — the same roles `projects.modules`/`.features`'s own
 * `can_manage_delivery()` RLS policy admits, ARCHITECTURE.md §3.2's
 * defense-in-depth). `task.write` gates tasks, matching `projects.tasks`'s
 * `can_write()` policy, which also admits `member`. No door function: none
 * of these writes carries a business rule beyond "the right role, in this
 * organization", which RLS already enforces on its own.
 */
export async function createModule(input: CreateModuleInput): Promise<Result<{ moduleId: string }>> {
  const parsed = createModuleSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid module.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to add a module.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('modules')
    .insert({
      organization_id: context.organizationId,
      project_id: parsed.data.projectId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'createModule', detail: error?.message }));
    if (error?.code === '23505') return err('CONFLICT', 'A module with that name already exists on this project.');
    return err('INTERNAL', 'Could not add the module.');
  }

  return ok({ moduleId: data.id });
}

export async function createFeature(input: CreateFeatureInput): Promise<Result<{ featureId: string }>> {
  const parsed = createFeatureSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid feature.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to add a feature.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('features')
    .insert({
      organization_id: context.organizationId,
      project_id: parsed.data.projectId,
      module_id: parsed.data.moduleId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'createFeature', detail: error?.message }));
    if (error?.code === '23505') return err('CONFLICT', 'A feature with that name already exists on this module.');
    return err('INTERNAL', 'Could not add the feature.');
  }

  return ok({ featureId: data.id });
}

export async function createTask(input: CreateTaskInput): Promise<Result<{ taskId: string }>> {
  const parsed = createTaskSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid task.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'task.write')) {
    return err('FORBIDDEN', 'You do not have permission to add a task.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('tasks')
    .insert({
      organization_id: context.organizationId,
      project_id: parsed.data.projectId,
      module_id: parsed.data.moduleId ?? null,
      feature_id: parsed.data.featureId ?? null,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'createTask', detail: error?.message }));
    return err('INTERNAL', 'Could not add the task.');
  }

  return ok({ taskId: data.id });
}

export async function setModuleStatus(input: SetModuleStatusInput): Promise<Result<{ updated: boolean }>> {
  const parsed = setModuleStatusSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Not a status this system recognises.');

  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to change a module’s status.');
  }

  const supabase = await createClient();
  const { error, count } = await supabase
    .schema('projects')
    .from('modules')
    .update({ status: parsed.data.status }, { count: 'exact' })
    .eq('id', parsed.data.moduleId);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setModuleStatus', detail: error.message }));
    return err('INTERNAL', 'Could not change the module’s status.');
  }
  return ok({ updated: (count ?? 0) > 0 });
}

export async function setFeatureStatus(input: SetFeatureStatusInput): Promise<Result<{ updated: boolean }>> {
  const parsed = setFeatureStatusSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Not a status this system recognises.');

  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to change a feature’s status.');
  }

  const supabase = await createClient();
  const { error, count } = await supabase
    .schema('projects')
    .from('features')
    .update({ status: parsed.data.status }, { count: 'exact' })
    .eq('id', parsed.data.featureId);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setFeatureStatus', detail: error.message }));
    return err('INTERNAL', 'Could not change the feature’s status.');
  }
  return ok({ updated: (count ?? 0) > 0 });
}

export async function setTaskStatus(input: SetTaskStatusInput): Promise<Result<{ updated: boolean }>> {
  const parsed = setTaskStatusSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Not a status this system recognises.');

  const context = await requireInternal();
  if (!can(context.role, 'task.write')) {
    return err('FORBIDDEN', 'You do not have permission to change a task’s status.');
  }

  const supabase = await createClient();
  const { error, count } = await supabase
    .schema('projects')
    .from('tasks')
    .update(
      {
        status: parsed.data.status,
        completed_at: parsed.data.status === 'done' ? new Date().toISOString() : null,
      },
      { count: 'exact' },
    )
    .eq('id', parsed.data.taskId);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setTaskStatus', detail: error.message }));
    return err('INTERNAL', 'Could not change the task’s status.');
  }
  return ok({ updated: (count ?? 0) > 0 });
}

/**
 * The scope baseline (Doc 11 §3, §29) — opening a draft, filling it, and
 * freezing it. `milestone.write` throughout: same capability
 * createModule/createFeature use, matching projects.scope_versions'/
 * .scope_items' can_manage_delivery() authority at the database doors.
 */
export async function openScopeVersion(input: OpenScopeVersionInput): Promise<Result<{ scopeVersionId: string; version: number }>> {
  const parsed = openScopeVersionSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid project.');

  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to open a scope baseline.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .rpc('open_scope_version', { p_project_id: parsed.data.projectId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'openScopeVersion', detail: error.message }));
    return err('INTERNAL', 'Could not open a scope baseline.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; scope_version_id?: string; version?: number }
    | undefined;

  switch (row?.outcome) {
    case 'opened':
      if (!row.scope_version_id || row.version === undefined) return err('INTERNAL', 'Could not open a scope baseline.');
      return ok({ scopeVersionId: row.scope_version_id, version: row.version });
    case 'draft_exists':
      return err('CONFLICT', 'A draft baseline is already open for this project.');
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    default:
      return err('INTERNAL', 'Could not open a scope baseline.');
  }
}

export async function addScopeItem(input: AddScopeItemInput): Promise<Result<{ scopeItemId: string }>> {
  const parsed = addScopeItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid scope item.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit a scope baseline.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('add_scope_item', {
    p_scope_version_id: parsed.data.scopeVersionId,
    p_title: parsed.data.title,
    p_detail: parsed.data.detail ?? null,
    p_inclusion: parsed.data.inclusion,
    p_acceptance_criteria: parsed.data.acceptanceCriteria ?? null,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addScopeItem', detail: error.message }));
    return err('INTERNAL', 'Could not add the scope item.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string } | undefined;

  switch (row?.outcome) {
    case 'added':
      if (!row.id) return err('INTERNAL', 'Could not add the scope item.');
      return ok({ scopeItemId: row.id });
    case 'not_draft':
      return err('CONFLICT', 'This baseline is already frozen and cannot be edited.');
    case 'not_found':
      return err('NOT_FOUND', 'Scope baseline not found.');
    case 'bad_title':
      return err('VALIDATION', 'A scope item needs a title.');
    case 'bad_inclusion':
      return err('VALIDATION', 'Not an inclusion state this system recognises.');
    default:
      return err('FORBIDDEN', 'You do not have permission to edit a scope baseline.');
  }
}

export async function removeScopeItem(input: RemoveScopeItemInput): Promise<Result<{ removed: boolean }>> {
  const parsed = removeScopeItemSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid scope item.');

  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit a scope baseline.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .rpc('remove_scope_item', { p_scope_item_id: parsed.data.scopeItemId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'removeScopeItem', detail: error.message }));
    return err('INTERNAL', 'Could not remove the scope item.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;

  switch (row?.outcome) {
    case 'removed':
      return ok({ removed: true });
    case 'not_draft':
      return err('CONFLICT', 'This baseline is already frozen and cannot be edited.');
    case 'not_found':
      return err('NOT_FOUND', 'Scope item not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to edit a scope baseline.');
  }
}

export async function freezeScopeVersion(input: FreezeScopeVersionInput): Promise<Result<{ items: number }>> {
  const parsed = freezeScopeVersionSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid scope baseline.');

  const context = await requireInternal();
  if (!can(context.role, 'milestone.write')) {
    return err('FORBIDDEN', 'You do not have permission to freeze a scope baseline.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .rpc('freeze_scope_version', { p_scope_version_id: parsed.data.scopeVersionId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'freezeScopeVersion', detail: error.message }));
    return err('INTERNAL', 'Could not freeze the scope baseline.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; items?: number } | undefined;

  switch (row?.outcome) {
    case 'frozen':
      return ok({ items: row.items ?? 0 });
    case 'empty':
      return err('VALIDATION', 'Add at least one scope item before freezing.');
    case 'not_draft':
      return err('CONFLICT', 'This baseline is not a draft.');
    case 'not_found':
      return err('NOT_FOUND', 'Scope baseline not found.');
    default:
      return err('INTERNAL', 'Could not freeze the scope baseline.');
  }
}
