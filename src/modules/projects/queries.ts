import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { PaymentPlanMilestone, ProjectDetail, ProjectListItem, DeliverableRow, CompletionSummary, OnboardingItem, UiCoverageFlag } from './types';

/**
 * Reads for the projects module. Pure and RLS-scoped, so the same query is
 * safe for staff and portal users — the policy decides which rows exist, and
 * this file carries no organization_id predicate for the reason explained in
 * crm/queries.ts.
 */

const LIST_SELECT = 'id, name, code, status, currency, budget_minor, created_at';
// `proposal_id` is on the detail because ADM-72 requires the accepted
// quotation's presence — or absence — to be *visible*, not merely auditable.
// It was written by conversion since G-017 and read by nothing until G-114.
const DETAIL_SELECT = `${LIST_SELECT}, description, client_account_id, opportunity_id, proposal_id, starts_on, ends_on`;

export async function listProjects(limit = 100): Promise<ProjectListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select(LIST_SELECT)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listProjects', error);
  return data ?? [];
}

export async function getProject(projectId: string): Promise<ProjectDetail | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select(DETAIL_SELECT)
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) unreadable('getProject', error);
  return data;
}

/** The project's payment plan, in milestone order. */
export async function listPaymentPlan(projectId: string): Promise<PaymentPlanMilestone[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('milestones')
    .select('id, name, position, status, payment_percent, amount_minor, currency, due_on')
    .eq('project_id', projectId)
    .order('position', { ascending: true });

  if (error) unreadable('listPaymentPlan', error);
  return data ?? [];
}

/**
 * Every version of everything shown on a project — Phase 12.
 *
 * Newest first within each kind, because the current version is what somebody
 * opening the page is looking for and the history is what they scroll to. The
 * older rows are never removed: an approval names a version, and the sequence
 * is the record of what was asked for and what changed.
 */
export async function listDeliverables(projectId: string): Promise<DeliverableRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('deliverables')
    .select('id, kind, version, title, artifact_url, changelog, known_issues, status, approval_request_id, created_at')
    .eq('project_id', projectId)
    .order('kind', { ascending: true })
    .order('version', { ascending: false });

  if (error) unreadable('listDeliverables', error);

  return data ?? [];
}

/**
 * How the project actually went — gap G-033, directive §23.
 *
 * Assembled from five tables that already held every fact. `.single()` rather
 * than reading `data[0]`: a project that returns no row is a read that could
 * not answer, and this makes it an error travelling the same path as any
 * other rather than a second refusal beside the first.
 */
export async function readCompletionSummary(projectId: string): Promise<CompletionSummary> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .rpc('completion_summary', { p_project_id: projectId })
    .single();

  if (error) unreadable('readCompletionSummary', error);

  return data as CompletionSummary;
}

/**
 * The onboarding checklist for a project, in Document 10 §6's order.
 *
 * G-017. Internal only — the checklist names what the agency still has to
 * chase out of the client and who inside the agency owes what, and RLS says
 * the same thing independently.
 */
/**
 * Doc 12 §9's screen coverage matrix for one project.
 *
 * *"This matrix is one of the main controls preventing an AI designer from
 * producing attractive but incomplete work."* Side-effect free, so a screen
 * can show it without pressing anything — the same shape as
 * `readCompletionSummary`. Internal only: it names work the agency owes,
 * and RLS on `projects.screens` says the same thing independently.
 */
export async function readUiCoverage(projectId: string): Promise<UiCoverageFlag[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .rpc('ui_coverage', { p_project_id: projectId });

  if (error) unreadable('readUiCoverage', error);

  return (data ?? []) as UiCoverageFlag[];
}

export async function listOnboardingItems(projectId: string): Promise<OnboardingItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('onboarding_items')
    .select('id, position, key, label, status, note, completed_at, completed_by')
    .eq('project_id', projectId)
    .order('position', { ascending: true });

  if (error) unreadable('listOnboardingItems', error);

  return data ?? [];
}

/**
 * The project WhatsApp group's name, and the group if one is linked — G-188.
 *
 * The brief specifies the name exactly — *PROJECT NAME // FINAL QUOTATION
 * PRICE // PROJECT START DATE // CLIENT NAME // identifier* — and nothing
 * composed it: `crm.conversations.title` was free text on a form. **Meta's
 * Cloud API has no Groups API** (#131215), so a person creates the group; the
 * one part of this step AgencyOS can do is hand them the exact name, and
 * before this it was not doing it.
 *
 * `missing` names the facts that are not there yet rather than assembling a
 * name around a guess — a title with an invented price would be read as the
 * price the client agreed.
 */
export type ProjectGroupName = {
  title: string | null;
  missing: string[];
  linked: { id: string; title: string | null; externalRef: string | null } | null;
};

export async function readProjectGroupName(projectId: string): Promise<ProjectGroupName> {
  const supabase = await createClient();

  const [{ data: composed, error: composeError }, { data: group, error: groupError }] =
    await Promise.all([
      supabase.schema('crm').rpc('project_group_title', { p_project_id: projectId }),
      supabase
        .schema('crm')
        .from('conversations')
        .select('id, title, external_ref')
        .eq('project_id', projectId)
        .eq('kind', 'project_group')
        .neq('status', 'abandoned')
        .maybeSingle(),
    ]);

  // G-054 on both, and the errors are renamed because the two reads share one
  // `Promise.all`: a page that rendered "no group yet" on a failed read would
  // state something it does not know, and this one is a start condition.
  if (composeError) unreadable('readProjectGroupName', composeError);
  if (groupError) unreadable('readProjectGroupName', groupError);

  const row = (Array.isArray(composed) ? composed[0] : composed) as
    | { title: string | null; missing: string[] | null }
    | undefined;

  return {
    title: row?.title ?? null,
    missing: row?.missing ?? [],
    linked: group ? { id: group.id, title: group.title, externalRef: group.external_ref } : null,
  };
}

/**
 * The WhatsApp group manual-action card — Master §5.5, §6; G-253.
 *
 * G-253 raises the card and records what a person did about it. This is the
 * read behind the surface that lets them do it: the four states, the member
 * snapshot as it was taken, who confirmed what and when.
 *
 * `members` is returned as stored rather than re-derived from the current
 * roster. That is the whole point of the snapshot (PM §8): a card confirmed in
 * March must keep showing the people who were actually added in March, even
 * after the team roster changes.
 */
export type GroupSetupMember = {
  name: string | null;
  phone: string | null;
  role: string | null;
  kind: 'internal' | 'client';
};

export type GroupSetupCard = {
  id: string;
  state: 'pending' | 'created' | 'mapped' | 'verified';
  suggestedName: string | null;
  suggestedNameMissing: string[];
  members: GroupSetupMember[];
  conversationId: string | null;
  requestedAt: string;
  createdAtWhatsapp: string | null;
  mappedAt: string | null;
  verifiedAt: string | null;
  note: string | null;
};

export async function readGroupSetup(projectId: string): Promise<GroupSetupCard | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('group_setups')
    .select('id, state, suggested_name, suggested_name_missing, members, conversation_id, requested_at, created_at_whatsapp, mapped_at, verified_at, note')
    .eq('project_id', projectId)
    .maybeSingle();

  // G-054: a read that failed is not a card that does not exist. The
  // difference matters here — "no card" renders a panel offering to raise one,
  // which would be a second card for a project that already has one.
  if (error) unreadable('readGroupSetup', error);

  // No row is a real answer: a project whose Phase 2 started before G-253 has
  // no card. Returned as an expression rather than an early `return null`,
  // which read-failure-semantics forbids within sight of an error guard —
  // rightly, since the two mean opposite things and would sit two lines apart.
  return data === null
    ? null
    : {
        id: data.id,
        state: data.state as GroupSetupCard['state'],
        suggestedName: data.suggested_name,
        suggestedNameMissing: data.suggested_name_missing ?? [],
        members: Array.isArray(data.members) ? (data.members as GroupSetupMember[]) : [],
        conversationId: data.conversation_id,
        requestedAt: data.requested_at,
        createdAtWhatsapp: data.created_at_whatsapp,
        mappedAt: data.mapped_at,
        verifiedAt: data.verified_at,
        note: data.note,
      };
}

/**
 * Every project waiting on the Admin's group step — Master §6's "general Admin
 * operational/manual-actions surface, not necessarily a page literally named
 * Phase 2".
 *
 * Lives on /operations beside the dead jobs and failed deliveries, because
 * that is already the page an operator opens to find out what is waiting for a
 * person. A second page would be a second place to forget to look.
 */
export type PendingGroupSetup = {
  setupId: string;
  projectId: string;
  projectName: string;
  state: 'pending' | 'created' | 'mapped';
  requestedAt: string;
  memberCount: number;
};

export async function listPendingGroupSetups(limit = 50): Promise<PendingGroupSetup[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('group_setups')
    .select('id, project_id, state, requested_at, members, projects(name)')
    .neq('state', 'verified')
    .order('requested_at', { ascending: true })
    .limit(limit);

  if (error) unreadable('listPendingGroupSetups', error);

  return (data ?? []).map((row) => ({
    setupId: row.id,
    projectId: row.project_id,
    projectName: (row.projects as { name?: string } | null)?.name ?? 'Unnamed project',
    state: row.state as PendingGroupSetup['state'],
    requestedAt: row.requested_at,
    memberCount: Array.isArray(row.members) ? row.members.length : 0,
  }));
}

/**
 * Phase 2's state, its readiness and its plan — G-263.
 *
 * G-250 through G-262 built the doors and left them unreachable: the phase,
 * the plan, its registers and the kickoff gate are all internal-only tables
 * that nothing rendered. This is the read behind the surface that makes them
 * usable, and it is deliberately ONE read — a panel that fired seven queries
 * would show seven moments of the same project.
 */
export type PhaseTwoView = {
  phase: { id: string; state: string; startedAt: string; kickoffAt: string | null; completedAt: string | null } | null;
  readiness: { ready: boolean; unmet: string[] } | null;
  plan: {
    id: string;
    version: number;
    status: string;
    objective: string | null;
    deliverables: number;
    dependencies: number;
    milestones: number;
    openQuestions: number;
  } | null;
};

export async function readPhaseTwo(projectId: string): Promise<PhaseTwoView> {
  const supabase = await createClient();

  const [{ data: phase, error: phaseError }, { data: plan, error: planError }, { data: gate, error: gateError }] =
    await Promise.all([
      supabase
        .schema('projects')
        .from('phase_two')
        .select('id, state, started_at, kickoff_at, completed_at')
        .eq('project_id', projectId)
        .maybeSingle(),
      supabase
        .schema('projects')
        .from('project_plans')
        .select('id, version, status, objective')
        .eq('project_id', projectId)
        .eq('status', 'active')
        .maybeSingle(),
      supabase.schema('projects').rpc('pre_kickoff_readiness', { p_project_id: projectId }),
    ]);

  // G-054 on all three, named separately because they share one Promise.all:
  // a panel that rendered "Phase 2 has not started" on a failed read would
  // state something it does not know, and this one carries a kickoff button.
  if (phaseError) unreadable('readPhaseTwo.phase', phaseError);
  if (planError) unreadable('readPhaseTwo.plan', planError);
  if (gateError) unreadable('readPhaseTwo.readiness', gateError);

  const gateRow = (Array.isArray(gate) ? gate[0] : gate) as
    | { ready?: boolean; unmet?: string[] | null }
    | undefined;

  // The registers are counted only when there is a plan to count them in.
  let counts = { deliverables: 0, dependencies: 0, milestones: 0, openQuestions: 0 };
  if (plan) {
    const [
      { count: deliverables, error: deliverablesError },
      { count: dependencies, error: dependenciesError },
      { count: milestones, error: milestonesError },
      { count: openQuestions, error: questionsError },
    ] = await Promise.all([
      supabase.schema('projects').from('plan_deliverables').select('id', { count: 'exact', head: true }).eq('plan_id', plan.id),
      supabase.schema('projects').from('plan_dependencies').select('id', { count: 'exact', head: true }).eq('plan_id', plan.id),
      supabase.schema('projects').from('plan_milestones').select('id', { count: 'exact', head: true }).eq('plan_id', plan.id),
      supabase
        .schema('projects')
        .from('plan_clarifications')
        .select('id', { count: 'exact', head: true })
        .eq('plan_id', plan.id)
        .not('status', 'in', '("resolved","routed_to_change_request")'),
    ]);

    // Written out rather than looped. `for (const read of …) if (read.error)`
    // is shorter and INVISIBLE to the meta-test in
    // read-failure-semantics.test.ts, which counts `if (<name>Error)` guards
    // against refusal calls: the dot in `read.error` means the guard is
    // not seen, the refusal is, and the invariant reports a reader that drops
    // a failure. The same lesson G-256 learned about RLS in a `do` block — a
    // control a static check cannot see is a control nobody can audit.
    if (deliverablesError) unreadable('readPhaseTwo.deliverables', deliverablesError);
    if (dependenciesError) unreadable('readPhaseTwo.dependencies', dependenciesError);
    if (milestonesError) unreadable('readPhaseTwo.milestones', milestonesError);
    if (questionsError) unreadable('readPhaseTwo.questions', questionsError);
    counts = {
      deliverables: deliverables ?? 0,
      dependencies: dependencies ?? 0,
      milestones: milestones ?? 0,
      openQuestions: openQuestions ?? 0,
    };
  }

  return {
    phase: phase
      ? {
          id: phase.id,
          state: phase.state,
          startedAt: phase.started_at,
          kickoffAt: phase.kickoff_at,
          completedAt: phase.completed_at,
        }
      : null,
    readiness: gateRow ? { ready: gateRow.ready === true, unmet: gateRow.unmet ?? [] } : null,
    plan: plan
      ? { id: plan.id, version: plan.version, status: plan.status, objective: plan.objective, ...counts }
      : null,
  };
}
