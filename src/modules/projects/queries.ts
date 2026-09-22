import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { resolveProjectContext } from './service';

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
    .select('id, name, position, status, payment_percent, amount_minor, currency, due_on, met_at')
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

export type DevelopmentModule = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  position: number;
  ownerId: string | null;
  dueOn: string | null;
};

export type DevelopmentFeature = {
  id: string;
  moduleId: string;
  name: string;
  description: string | null;
  status: string;
  position: number;
};

export type DevelopmentTask = {
  id: string;
  moduleId: string | null;
  featureId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  dueOn: string | null;
  completedAt: string | null;
};

/**
 * Phase 5's breakdown — modules → features → tasks. Doc 15's Development
 * Planning Agent and its Admin Panel screens (SCR-039/040) had schema for all
 * three (20260813120004, 20260813120024) and no reader anywhere: a task
 * board nothing could populate is the same defect as one nothing could read.
 *
 * Three flat reads rather than one nested one — PostgREST embeds work within
 * a schema but the page assembles the hierarchy itself, the same choice
 * lib/admin/clients.ts made for the same reason: explicit and easy to audit
 * beats a deep embed nobody can read at a glance.
 */
export async function listDevelopmentBreakdown(
  projectId: string,
): Promise<{ modules: DevelopmentModule[]; features: DevelopmentFeature[]; tasks: DevelopmentTask[] }> {
  const supabase = await createClient();

  const [{ data: moduleRows, error: modulesError }, { data: featureRows, error: featuresError }, { data: taskRows, error: tasksError }] =
    await Promise.all([
      supabase
        .schema('projects')
        .from('modules')
        .select('id, name, description, status, position, owner_id, due_on')
        .eq('project_id', projectId)
        .order('position', { ascending: true }),
      supabase
        .schema('projects')
        .from('features')
        .select('id, module_id, name, description, status, position')
        .eq('project_id', projectId)
        .order('position', { ascending: true }),
      supabase
        .schema('projects')
        .from('tasks')
        .select('id, module_id, feature_id, title, description, status, priority, assignee_id, due_on, completed_at')
        .eq('project_id', projectId)
        .order('created_at', { ascending: true }),
    ]);

  if (modulesError) unreadable('listDevelopmentBreakdown.modules', modulesError);
  if (featuresError) unreadable('listDevelopmentBreakdown.features', featuresError);
  if (tasksError) unreadable('listDevelopmentBreakdown.tasks', tasksError);

  return {
    modules: (moduleRows ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      status: m.status,
      position: m.position,
      ownerId: m.owner_id,
      dueOn: m.due_on,
    })),
    features: (featureRows ?? []).map((f) => ({
      id: f.id,
      moduleId: f.module_id,
      name: f.name,
      description: f.description,
      status: f.status,
      position: f.position,
    })),
    tasks: (taskRows ?? []).map((t) => ({
      id: t.id,
      moduleId: t.module_id,
      featureId: t.feature_id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      assigneeId: t.assignee_id,
      dueOn: t.due_on,
      completedAt: t.completed_at,
    })),
  };
}

export type ScopeItemRow = {
  id: string;
  title: string;
  detail: string | null;
  inclusion: string;
  acceptanceCriteria: string | null;
  position: number;
};

export type ScopeVersionRow = {
  id: string;
  version: number;
  status: string;
  source: string;
  frozenAt: string | null;
  createdAt: string;
  items: ScopeItemRow[];
};

/**
 * The scope baseline (Doc 11) for one project — the active/frozen version if
 * one exists, and the open draft if one is being assembled. At most one of
 * each: the partial-unique index on `active` status and
 * `open_scope_version`'s own `draft_exists` refusal both hold this
 * mechanically at the database, not just by convention here.
 */
export async function readScopeBaseline(
  projectId: string,
): Promise<{ active: ScopeVersionRow | null; draft: ScopeVersionRow | null }> {
  const supabase = await createClient();

  const { data: versionRows, error: versionsError } = await supabase
    .schema('projects')
    .from('scope_versions')
    .select('id, version, status, source, frozen_at, created_at')
    .eq('project_id', projectId)
    .in('status', ['active', 'draft'])
    .order('version', { ascending: false });

  if (versionsError) unreadable('readScopeBaseline.versions', versionsError);

  const rows = versionRows ?? [];
  if (rows.length === 0) return { active: null, draft: null };

  const versionIds = rows.map((v) => v.id);
  const { data: itemRows, error: itemsError } = await supabase
    .schema('projects')
    .from('scope_items')
    .select('id, scope_version_id, title, detail, inclusion, acceptance_criteria, position')
    .in('scope_version_id', versionIds)
    .order('position', { ascending: true });

  if (itemsError) unreadable('readScopeBaseline.items', itemsError);

  const itemsByVersion = new Map<string, ScopeItemRow[]>();
  for (const i of itemRows ?? []) {
    const list = itemsByVersion.get(i.scope_version_id) ?? [];
    list.push({
      id: i.id,
      title: i.title,
      detail: i.detail,
      inclusion: i.inclusion,
      acceptanceCriteria: i.acceptance_criteria,
      position: i.position,
    });
    itemsByVersion.set(i.scope_version_id, list);
  }

  const toRow = (v: (typeof rows)[number]): ScopeVersionRow => ({
    id: v.id,
    version: v.version,
    status: v.status,
    source: v.source,
    frozenAt: v.frozen_at,
    createdAt: v.created_at,
    items: itemsByVersion.get(v.id) ?? [],
  });

  const activeRow = rows.find((v) => v.status === 'active');
  const draftRow = rows.find((v) => v.status === 'draft');

  return {
    active: activeRow ? toRow(activeRow) : null,
    draft: draftRow ? toRow(draftRow) : null,
  };
}

export type ScopeVersionSummary = {
  id: string;
  version: number;
  status: string;
  source: string;
  frozenAt: string | null;
  createdAt: string;
  itemCount: number;
};

/**
 * Every scope version ever raised, not just the two `readScopeBaseline`
 * cares about (active + open draft) — SCR-030's history half, confirmed
 * genuinely missing. `superseded` versions are read-only history once an
 * approved change moves past them (the migration's own comment), and until
 * now nothing read them back: a scope dispute a year later had no way to
 * see what version 1 actually said. Item counts only, not full item bodies —
 * a history list answers "what changed between versions", which a count
 * and a status already does; opening one version's full detail is
 * `readScopeBaseline`'s job for the still-live ones, and superseded
 * versions are read via this same table if a future screen needs the items.
 */
export async function listScopeVersionHistory(projectId: string): Promise<ScopeVersionSummary[]> {
  const supabase = await createClient();

  const { data: versionRows, error: versionsError } = await supabase
    .schema('projects')
    .from('scope_versions')
    .select('id, version, status, source, frozen_at, created_at')
    .eq('project_id', projectId)
    .order('version', { ascending: false });
  if (versionsError) unreadable('listScopeVersionHistory.versions', versionsError);

  const rows = versionRows ?? [];
  if (rows.length === 0) return [];

  const { data: itemRows, error: itemsError } = await supabase
    .schema('projects')
    .from('scope_items')
    .select('scope_version_id')
    .in(
      'scope_version_id',
      rows.map((v) => v.id),
    );
  if (itemsError) unreadable('listScopeVersionHistory.items', itemsError);

  const countByVersion = new Map<string, number>();
  for (const i of itemRows ?? []) {
    countByVersion.set(i.scope_version_id, (countByVersion.get(i.scope_version_id) ?? 0) + 1);
  }

  return rows.map((v) => ({
    id: v.id,
    version: v.version,
    status: v.status,
    source: v.source,
    frozenAt: v.frozen_at,
    createdAt: v.created_at,
    itemCount: countByVersion.get(v.id) ?? 0,
  }));
}

export type ChangeRequestRow = {
  id: string;
  source: string;
  requested: string;
  classification: string | null;
  status: string;
  impactNotes: string | null;
  timelineDays: number | null;
  effortHours: number | null;
  proposalId: string | null;
  scopeVersionId: string;
  resultingScopeVersionId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
};

/**
 * Doc 11 §16–§21 — every change request against this project, newest first.
 *
 * Full detail, unlike `readPlanBoard`'s `id, requested, status` — that read
 * exists only to populate the clarification-routing picker, and this one is
 * for the classify/decide/apply surface itself, which needs every column
 * those doors read or write.
 */
export async function readChangeRequests(projectId: string): Promise<ChangeRequestRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('change_requests')
    .select(
      'id, source, requested, classification, status, impact_notes, timeline_days, effort_hours, proposal_id, scope_version_id, resulting_scope_version_id, decided_by, decided_at, created_at',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) unreadable('readChangeRequests', error);

  return (data ?? []).map((row) => ({
    id: row.id,
    source: row.source,
    requested: row.requested,
    classification: row.classification,
    status: row.status,
    impactNotes: row.impact_notes,
    timelineDays: row.timeline_days,
    effortHours: row.effort_hours === null ? null : Number(row.effort_hours),
    proposalId: row.proposal_id,
    scopeVersionId: row.scope_version_id,
    resultingScopeVersionId: row.resulting_scope_version_id,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  }));
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

/**
 * The internal team roster every WhatsApp group card is prepared from — G-267.
 *
 * G-253 built the table with a SELECT policy and no way in. Nothing in the
 * product could put a person on it, so every card since has carried the
 * client's contacts and none of the agency's own team.
 */
export type TeamDefault = {
  id: string;
  displayName: string;
  phone: string;
  role: string | null;
  active: boolean;
  position: number;
};

export async function listTeamDefaults(): Promise<TeamDefault[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('group_team_defaults')
    .select('id, display_name, phone, role, active, position')
    .order('position', { ascending: true })
    .order('display_name', { ascending: true });

  if (error) unreadable('listTeamDefaults', error);

  return (data ?? []).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    phone: row.phone,
    role: row.role,
    active: row.active,
    position: row.position,
  }));
}

/**
 * The operational plan, in full — Project Planning §7; G-274.
 *
 * G-263 gave Phase 2 a surface that reads plan COUNTS, and nothing has ever
 * read a plan's rows or written one. Every door G-256, G-257, G-262 and G-265
 * built is unreachable from the product: a project plan cannot be made at all.
 *
 * §7's blueprint is eighteen registers, so this is one read that returns the
 * whole thing rather than eighteen round trips. The scope items come with it
 * because a deliverable must name approved scope (G-256) and a form that makes
 * somebody paste a UUID is a form that gets the wrong UUID pasted into it.
 */
export type PlanBoard = {
  plan: {
    id: string;
    version: number;
    status: string;
    objective: string | null;
    scopeVersionId: string | null;
  } | null;
  deliverables: {
    id: string;
    name: string;
    applicablePhase: string;
    status: string;
    ownerRole: string | null;
    readinessCriteria: string;
    evidenceRequired: string;
    ambiguityNote: string | null;
    scopeItemId: string | null;
  }[];
  milestones: { id: string; name: string; kind: string; phase: string; status: string; gateCriteria: string }[];
  dependencies: { id: string; kind: string; description: string; neededByPhase: string; ownerRole: string; status: string }[];
  notes: { id: string; kind: string; statement: string; ownerRole: string | null }[];
  clarifications: { id: string; question: string; status: string; answer: string | null }[];
  scopeItems: { id: string; title: string; inclusion: string }[];
  /**
   * §10's second ending needs somewhere to send the question. The picker
   * offers the project's own change requests and nothing else — routing a
   * clarification onto another project's change request would price one
   * client's new work onto another's, which is the refusal
   * `route_clarification_to_change_request` answers `wrong_project`.
   */
  changeRequests: { id: string; requested: string; status: string }[];
  /** §15's gates, as they stand: which dependency each milestone waits on. */
  gates: { milestoneId: string; dependencyId: string }[];
};

export async function readPlanBoard(projectId: string): Promise<PlanBoard> {
  const supabase = await createClient();

  const { data: planRow, error: planError } = await supabase
    .schema('projects')
    .from('project_plans')
    .select('id, version, status, objective, scope_version_id')
    .eq('project_id', projectId)
    .in('status', ['draft', 'active'])
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (planError) unreadable('readPlanBoard.plan', planError);

  const { data: scopeRows, error: scopeError } = await supabase
    .schema('projects')
    .from('scope_items')
    .select('id, title, inclusion, scope_version_id')
    .eq('scope_version_id', planRow?.scope_version_id ?? '00000000-0000-0000-0000-000000000000');

  if (scopeError) unreadable('readPlanBoard.scope', scopeError);

  const empty: PlanBoard = {
    plan: null,
    deliverables: [],
    milestones: [],
    dependencies: [],
    notes: [],
    clarifications: [],
    scopeItems: [],
    changeRequests: [],
    gates: [],
  };

  // No plan is not a failed read: most projects have never had one drafted,
  // and the page's whole job in that case is to offer to start one.
  if (!planRow) return empty;

  const [deliverables, milestones, dependencies, notes, clarifications, changeRequests, gates] = await Promise.all([
    supabase.schema('projects').from('plan_deliverables')
      .select('id, name, applicable_phase, status, owner_role, readiness_criteria, evidence_required, ambiguity_note, scope_item_id')
      .eq('plan_id', planRow.id).order('position', { ascending: true }),
    supabase.schema('projects').from('plan_milestones')
      .select('id, name, kind, phase, status, gate_criteria')
      .eq('plan_id', planRow.id).order('position', { ascending: true }),
    supabase.schema('projects').from('plan_dependencies')
      .select('id, kind, description, needed_by_phase, owner_role, status')
      .eq('plan_id', planRow.id).order('created_at', { ascending: true }),
    supabase.schema('projects').from('plan_notes')
      .select('id, kind, statement, owner_role')
      .eq('plan_id', planRow.id).order('created_at', { ascending: true }),
    supabase.schema('projects').from('plan_clarifications')
      .select('id, question, status, answer')
      .eq('plan_id', planRow.id).order('created_at', { ascending: true }),
    supabase.schema('projects').from('change_requests')
      .select('id, requested, status')
      .eq('project_id', projectId).order('created_at', { ascending: false }),
    supabase.schema('projects').from('plan_milestone_dependencies')
      .select('milestone_id, dependency_id'),
  ]);

  // Five reads, five refusals. A register that failed to load is not an empty
  // register: a plan missing its risks reads as a plan with no risks, and
  // somebody activates it.
  const boardError =
    deliverables.error ?? milestones.error ?? dependencies.error ?? notes.error ?? clarifications.error
    ?? changeRequests.error ?? gates.error;
  if (boardError) unreadable('readPlanBoard.registers', boardError);

  return {
    plan: {
      id: planRow.id,
      version: planRow.version,
      status: planRow.status,
      objective: planRow.objective,
      scopeVersionId: planRow.scope_version_id,
    },
    deliverables: (deliverables.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      applicablePhase: row.applicable_phase,
      status: row.status,
      ownerRole: row.owner_role,
      readinessCriteria: row.readiness_criteria,
      evidenceRequired: row.evidence_required,
      ambiguityNote: row.ambiguity_note,
      scopeItemId: row.scope_item_id,
    })),
    milestones: (milestones.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      phase: row.phase,
      status: row.status,
      gateCriteria: row.gate_criteria,
    })),
    dependencies: (dependencies.data ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      description: row.description,
      neededByPhase: row.needed_by_phase,
      ownerRole: row.owner_role,
      status: row.status,
    })),
    notes: (notes.data ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      statement: row.statement,
      ownerRole: row.owner_role,
    })),
    clarifications: (clarifications.data ?? []).map((row) => ({
      id: row.id,
      question: row.question,
      status: row.status,
      answer: row.answer,
    })),
    scopeItems: (scopeRows ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      inclusion: row.inclusion,
    })),
    changeRequests: (changeRequests.data ?? []).map((row) => ({
      id: row.id,
      requested: row.requested,
      status: row.status,
    })),
    // RLS scopes these to the organisation; the plan's own milestones filter
    // the rest, so a gate from another project cannot be rendered on this one.
    gates: (gates.data ?? [])
      .filter((row) => (milestones.data ?? []).some((m) => m.id === row.milestone_id))
      .map((row) => ({ milestoneId: row.milestone_id, dependencyId: row.dependency_id })),
  };
}

/**
 * What is still worth asking this client — PM §4.1, §4.2, §6 PM-03; G-276.
 *
 * Two units that each answer half of *"do not re-ask known details"* and
 * neither of which anything called.
 *
 * `resolveProjectContext` (G-252) says what **Phase 1 already confirmed**, so
 * nobody asks for a budget the client stated on the call. Its whole service
 * function was dead: one occurrence in the repository, its own definition.
 *
 * `projects.outstanding_client_requests` (G-266) says what is **still
 * unsettled and which single item is the next question** — and distinguishes
 * *outstanding* from *askable*, which is the distinction the whole thing turns
 * on: an item already asked, and an item they answered that nobody here has
 * checked, are both outstanding and neither is a question.
 *
 * Both halves fail soft in one specific way and that is deliberate: a project
 * with **no WON handoff packet** has no inherited context to show, and that is
 * a fact about the project rather than a read failure. Everything else
 * refuses.
 */
export type NextQuestions = {
  /** Null when this project has no handoff packet to inherit from. */
  known: readonly string[] | null;
  outstanding: {
    itemId: string;
    key: string;
    label: string;
    status: string;
    withClient: boolean;
    withUs: boolean;
    askNext: boolean;
  }[];
};

export async function readNextQuestions(projectId: string): Promise<NextQuestions> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .rpc('outstanding_client_requests', { p_project_id: projectId });

  if (error) unreadable('readNextQuestions', error);

  const context = await resolveProjectContext(projectId, supabase);

  return {
    // A project with no handoff packet answers NOT_FOUND, and that is not a
    // failure: G-250 starts Phase 2 at the binding, and every project
    // converted before it has none. Any other failure is reported as null too
    // — the page says "not available" rather than "nothing was confirmed",
    // because those are different and only one of them is safe to act on.
    known: context.ok ? context.data.knownKeys.map(String) : null,
    outstanding: ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      itemId: String(row.item_id),
      key: String(row.key),
      label: String(row.label),
      status: String(row.status),
      withClient: row.with_client === true,
      withUs: row.with_us === true,
      askNext: row.ask_next === true,
    })),
  };
}

/**
 * The words to copy for the one thing still worth asking — G-266, ADM-109.
 *
 * `readNextQuestions` says WHICH item is askable; this renders WHAT TO WRITE
 * for it, the same "renders, does not send" shape `readDesignMessages` gives
 * Phase 3. Nothing here touches ADM-109's still-open half — cadence, channel,
 * policy-based follow-up — it only stops a PM from composing the same
 * message by hand for every project.
 */
export type MissingInfoMessage = {
  body: string | null;
  blockedReason: string | null;
};

export async function readMissingInfoMessage(projectId: string): Promise<MissingInfoMessage> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .rpc('render_missing_info_message', { p_project_id: projectId });

  // G-054: a failed read is not "nothing to ask" — those are different facts,
  // and only one of them is safe to act on.
  if (error) unreadable('readMissingInfoMessage', error);

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; body?: string | null } | undefined;

  if (row?.outcome === 'rendered') {
    return { body: row.body ?? null, blockedReason: null };
  }

  const NOT_YET: Record<string, string> = {
    nothing_to_ask: 'Nothing to ask right now.',
    unknown_project: 'This project could not be found.',
  };

  return {
    body: null,
    blockedReason: NOT_YET[row?.outcome ?? ''] ?? 'You do not have permission to read this project’s messages.',
  };
}

/**
 * The Phase 3 decision trail — Master §8, §10; G-286.
 *
 * G-277 through G-285 built eleven tables, nine doors and the whole
 * designer → internal → Admin → PM → client order, and rendered **none of it**.
 * Every one of those tables is internal-only with no write policy, so until
 * this read existed the entire phase was visible to somebody with a database
 * client and to nobody else.
 *
 * §8 is not asking for a status badge. Its sentence is *"Admin must be able to
 * inspect not only the final selected UI, but the **complete decision
 * trail**"*, and it marks one row *very important*: *"which UI samples were
 * sent to this client?"* — **without reading WhatsApp manually.** That is why
 * G-282 froze the share as a snapshot, and this is the read that finally
 * answers the question it was built for.
 *
 * **One read, not thirteen.** Thirteen panels each firing their own query
 * would show thirteen moments of the same project, and a decision trail whose
 * rows disagree about when they were taken is not a trail. The cost is one
 * wide function; the alternative is a surface that can contradict itself.
 */
export type DesignTrailView = {
  phase: {
    id: string;
    state: string;
    blockedReason: string | null;
    revisionCount: number;
    revisionLimit: number;
    reviewerUserId: string | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
  baseline: { id: string; version: number; status: string; screenCount: number; screens: unknown[] } | null;
  themes: {
    id: string;
    optionIndex: number;
    name: string;
    directionSummary: string;
    version: number;
    origin: string;
    internalReviewStatus: string;
    adminStatus: string;
    clientStatus: string;
    figmaFileKey: string | null;
    figmaNodeId: string | null;
    figmaNodeName: string | null;
    figmaVerifiedAt: string | null;
    figmaVersion: string | null;
    previewAssetUrl: string | null;
    colors: {
      id: string;
      optionIndex: number;
      paletteName: string;
      clientStatus: string;
      swatches: string[];
    }[];
  }[];
  reviews: { id: string; themeOptionId: string; result: string; comments: string | null; createdAt: string }[];
  adminDecisions: { id: string; themeOptionId: string; decision: string; reason: string | null; createdAt: string }[];
  shares: {
    id: string;
    shareNumber: number;
    channel: string;
    evidenceRef: string;
    optionCount: number;
    sharedOptions: unknown[];
    createdAt: string;
  }[];
  clientDecisions: {
    id: string;
    decision: string;
    clientWords: string;
    evidenceRef: string | null;
    selectedThemeOptionId: string | null;
    selectedColorOptionId: string | null;
    createdAt: string;
  }[];
  revisions: {
    id: string;
    origin: string;
    roundNumber: number | null;
    status: string;
    requestedChanges: string;
    fromThemeOptionId: string;
    toThemeOptionId: string | null;
    // The idempotency key: which client decision opened this round, if any.
    // A surface offering to open one again would only ever get `exists` back.
    clientDecisionId: string | null;
    createdAt: string;
  }[];
  handoff: {
    id: string;
    phaseFourReady: boolean;
    readinessNote: string | null;
    figmaNodeId: string | null;
    figmaVersion: string | null;
    themeOptionId: string;
    colorOptionId: string;
    lockedAt: string;
  } | null;
};

export async function readDesignTrail(projectId: string): Promise<DesignTrailView> {
  const supabase = await createClient();

  const { data: phase, error: phaseError } = await supabase
    .schema('projects')
    .from('phase_three')
    .select('id, state, blocked_reason, client_revision_count, client_revision_limit, reviewer_user_id, started_at, completed_at')
    .eq('project_id', projectId)
    .maybeSingle();
  if (phaseError) unreadable('readDesignTrail.phase', phaseError);

  // The rest of the trail hangs off the phase. Without one there is nothing to
  // read, and firing nine queries to learn that would be nine ways to fail.
  if (!phase) {
    return {
      phase: null, baseline: null, themes: [], reviews: [], adminDecisions: [],
      shares: [], clientDecisions: [], revisions: [], handoff: null,
    };
  }

  const [
    { data: baseline, error: baselineError },
    { data: themes, error: themesError },
    { data: reviews, error: reviewsError },
    { data: adminDecisions, error: adminError },
    { data: shares, error: sharesError },
    { data: clientDecisions, error: clientError },
    { data: revisions, error: revisionsError },
    { data: handoff, error: handoffError },
  ] = await Promise.all([
    supabase
      .schema('projects')
      .from('screen_baselines')
      .select('id, version, status, screen_count, screens')
      .eq('project_id', projectId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .schema('projects')
      .from('theme_options')
      .select('id, option_index, name, direction_summary, version, origin, internal_review_status, admin_status, client_status, figma_file_key, figma_node_id, figma_node_name, figma_verified_at, figma_version, preview_asset_url')
      .eq('phase_three_id', phase.id)
      .order('option_index', { ascending: true }),
    supabase
      .schema('projects')
      .from('design_reviews')
      .select('id, theme_option_id, result, comments, created_at')
      .eq('phase_three_id', phase.id)
      .order('created_at', { ascending: false }),
    supabase
      .schema('projects')
      .from('admin_design_decisions')
      .select('id, theme_option_id, decision, reason, created_at')
      .eq('phase_three_id', phase.id)
      .order('created_at', { ascending: false }),
    supabase
      .schema('projects')
      .from('client_design_shares')
      .select('id, share_number, channel, evidence_ref, option_count, shared_options, created_at')
      .eq('phase_three_id', phase.id)
      .order('share_number', { ascending: false }),
    supabase
      .schema('projects')
      .from('client_design_decisions')
      .select('id, decision, client_words, evidence_ref, selected_theme_option_id, selected_color_option_id, created_at')
      .eq('phase_three_id', phase.id)
      .order('created_at', { ascending: false }),
    supabase
      .schema('projects')
      .from('design_revisions')
      .select('id, origin, round_number, status, requested_changes, from_theme_option_id, to_theme_option_id, client_decision_id, created_at')
      .eq('phase_three_id', phase.id)
      .order('created_at', { ascending: false }),
    supabase
      .schema('projects')
      .from('phase_three_handoffs')
      .select('id, phase_four_ready, readiness_note, figma_node_id, figma_version, theme_option_id, color_option_id, locked_at')
      .eq('phase_three_id', phase.id)
      .maybeSingle(),
  ]);

  // G-054 on every one of them, named separately. A trail that rendered "no
  // client feedback" on a failed read would state something about a client
  // that nobody checked — and §8's whole point is that this page is where an
  // Admin goes instead of reading WhatsApp.
  if (baselineError) unreadable('readDesignTrail.baseline', baselineError);
  if (themesError) unreadable('readDesignTrail.themes', themesError);
  if (reviewsError) unreadable('readDesignTrail.reviews', reviewsError);
  if (adminError) unreadable('readDesignTrail.adminDecisions', adminError);
  if (sharesError) unreadable('readDesignTrail.shares', sharesError);
  if (clientError) unreadable('readDesignTrail.clientDecisions', clientError);
  if (revisionsError) unreadable('readDesignTrail.revisions', revisionsError);
  if (handoffError) unreadable('readDesignTrail.handoff', handoffError);

  const themeRows = (themes ?? []) as Record<string, unknown>[];
  const themeIds = themeRows.map((t) => t.id as string);

  // §12 makes a colour belong to a theme, so the palettes are read by theme
  // rather than by project — there is no project column to read them by.
  let colorRows: Record<string, unknown>[] = [];
  if (themeIds.length > 0) {
    const { data: colors, error: colorsError } = await supabase
      .schema('projects')
      .from('color_options')
      .select('id, theme_option_id, option_index, palette_name, client_status, primary_hex, secondary_hex, accent_hex, background_hex, surface_hex')
      .in('theme_option_id', themeIds)
      .order('option_index', { ascending: true });
    if (colorsError) unreadable('readDesignTrail.colors', colorsError);
    colorRows = (colors ?? []) as Record<string, unknown>[];
  }

  return {
    phase: {
      id: phase.id as string,
      state: phase.state as string,
      blockedReason: (phase.blocked_reason as string | null) ?? null,
      revisionCount: (phase.client_revision_count as number) ?? 0,
      revisionLimit: (phase.client_revision_limit as number) ?? 0,
      reviewerUserId: (phase.reviewer_user_id as string | null) ?? null,
      startedAt: phase.started_at as string,
      completedAt: (phase.completed_at as string | null) ?? null,
    },
    baseline: baseline
      ? {
          id: baseline.id as string,
          version: baseline.version as number,
          status: baseline.status as string,
          screenCount: (baseline.screen_count as number) ?? 0,
          screens: (baseline.screens as unknown[]) ?? [],
        }
      : null,
    themes: themeRows.map((t) => ({
      id: t.id as string,
      optionIndex: t.option_index as number,
      name: t.name as string,
      directionSummary: t.direction_summary as string,
      version: t.version as number,
      origin: t.origin as string,
      internalReviewStatus: t.internal_review_status as string,
      adminStatus: t.admin_status as string,
      clientStatus: t.client_status as string,
      figmaFileKey: (t.figma_file_key as string | null) ?? null,
      figmaNodeId: (t.figma_node_id as string | null) ?? null,
      figmaNodeName: (t.figma_node_name as string | null) ?? null,
      figmaVerifiedAt: (t.figma_verified_at as string | null) ?? null,
      figmaVersion: (t.figma_version as string | null) ?? null,
      previewAssetUrl: (t.preview_asset_url as string | null) ?? null,
      colors: colorRows
        .filter((c) => c.theme_option_id === t.id)
        .map((c) => ({
          id: c.id as string,
          optionIndex: c.option_index as number,
          paletteName: c.palette_name as string,
          clientStatus: c.client_status as string,
          swatches: [c.primary_hex, c.secondary_hex, c.accent_hex, c.background_hex, c.surface_hex]
            .filter((h): h is string => typeof h === 'string'),
        })),
    })),
    reviews: ((reviews ?? []) as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      themeOptionId: r.theme_option_id as string,
      result: r.result as string,
      comments: (r.comments as string | null) ?? null,
      createdAt: r.created_at as string,
    })),
    adminDecisions: ((adminDecisions ?? []) as Record<string, unknown>[]).map((a) => ({
      id: a.id as string,
      themeOptionId: a.theme_option_id as string,
      decision: a.decision as string,
      reason: (a.reason as string | null) ?? null,
      createdAt: a.created_at as string,
    })),
    shares: ((shares ?? []) as Record<string, unknown>[]).map((s) => ({
      id: s.id as string,
      shareNumber: s.share_number as number,
      channel: s.channel as string,
      evidenceRef: s.evidence_ref as string,
      optionCount: (s.option_count as number) ?? 0,
      sharedOptions: (s.shared_options as unknown[]) ?? [],
      createdAt: s.created_at as string,
    })),
    clientDecisions: ((clientDecisions ?? []) as Record<string, unknown>[]).map((c) => ({
      id: c.id as string,
      decision: c.decision as string,
      clientWords: c.client_words as string,
      evidenceRef: (c.evidence_ref as string | null) ?? null,
      selectedThemeOptionId: (c.selected_theme_option_id as string | null) ?? null,
      selectedColorOptionId: (c.selected_color_option_id as string | null) ?? null,
      createdAt: c.created_at as string,
    })),
    revisions: ((revisions ?? []) as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      origin: r.origin as string,
      roundNumber: (r.round_number as number | null) ?? null,
      status: r.status as string,
      requestedChanges: r.requested_changes as string,
      fromThemeOptionId: r.from_theme_option_id as string,
      toThemeOptionId: (r.to_theme_option_id as string | null) ?? null,
      clientDecisionId: (r.client_decision_id as string | null) ?? null,
      createdAt: r.created_at as string,
    })),
    handoff: handoff
      ? {
          id: handoff.id as string,
          phaseFourReady: handoff.phase_four_ready === true,
          readinessNote: (handoff.readiness_note as string | null) ?? null,
          figmaNodeId: (handoff.figma_node_id as string | null) ?? null,
          figmaVersion: (handoff.figma_version as string | null) ?? null,
          themeOptionId: handoff.theme_option_id as string,
          colorOptionId: handoff.color_option_id as string,
          lockedAt: handoff.locked_at as string,
        }
      : null,
  };
}

/**
 * Who can hold the internal design gate — Master §4; G-287.
 *
 * `assign_design_reviewer` refuses a user who is not on this organisation's
 * roster, so the picker offers exactly the people the door will accept. A free
 * text id field would have made "unknown_user" the normal outcome of using it.
 *
 * Client users are excluded at the database by `core.memberships` itself —
 * a membership is the internal roster, and a portal user does not have one.
 */
export type RosterMember = { userId: string; fullName: string; email: string; role: string };

export async function listInternalRoster(): Promise<RosterMember[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('memberships')
    .select('user_id, role, users:user_id(full_name, email)')
    .order('role', { ascending: true });
  if (error) unreadable('listInternalRoster', error);

  return ((data ?? []) as Record<string, unknown>[]).map((m) => {
    const user = (m.users ?? {}) as { full_name?: string | null; email?: string | null };
    return {
      userId: m.user_id as string,
      fullName: user.full_name ?? user.email ?? 'someone without a name on file',
      email: user.email ?? '',
      role: m.role as string,
    };
  });
}

/**
 * The roster, with each member's additional roles — multirole (G-310).
 *
 * `listInternalRoster` above answers "who, and their one primary role" and
 * has callers that need exactly that and nothing more. This answers the
 * wider question the member-roles admin panel needs: primary role AND
 * every secondary role `core.membership_roles` carries for them, so the
 * panel can render one row per person rather than joining two reads itself.
 *
 * Two queries, not a join in SQL: memberships and membership_roles are read
 * through two different RLS-scoped selects rather than one embedded query,
 * because PostgREST's embedding syntax for two tables related indirectly
 * through `id`/`membership_id` (not a direct FK PostgREST discovers) would
 * need a view this feature does not otherwise need. A roster is small — this
 * is an admin settings page, not a hot path.
 */
export type RosterMemberWithRoles = RosterMember & {
  membershipId: string;
  secondaryRoles: string[];
  status: 'active' | 'suspended';
  createdAt: string;
};

export async function listInternalRosterWithRoles(): Promise<RosterMemberWithRoles[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('memberships')
    .select('id, user_id, role, status, created_at, organization_id, users:user_id(full_name, email)')
    .order('role', { ascending: true });
  if (error) unreadable('listInternalRosterWithRoles', error);

  const rows = (data ?? []) as Record<string, unknown>[];
  const organizationId = rows[0]?.organization_id as string | undefined;

  let secondaryByMembership = new Map<string, string[]>();
  if (organizationId) {
    const { data: roleRows, error: roleError } = await supabase
      .schema('core')
      .rpc('list_membership_roles', { p_organization_id: organizationId });

    if (roleError) {
      // PGRST202 / 42883: the function is not in PostgREST's schema cache yet.
      // Application code deploys on merge; the migration that creates
      // core.list_membership_roles is a separate, manually-run production
      // step (ADM-20/60) — so there is a real window where this code is live
      // and the function is not. That must not take the WHOLE settings page
      // down over one still-optional panel: every other reader on this page
      // (timezone, WhatsApp config, pricing) has nothing to do with roles.
      // Any OTHER failure still fails loud, per G-054 — this degrades only
      // the one case that means "not deployed yet", not "something is wrong".
      const code = (roleError as { code?: string }).code;
      if (code === 'PGRST202' || code === '42883') {
        console.error(
          JSON.stringify({
            level: 'error',
            scope: 'listInternalRosterWithRoles.roles',
            detail: `${roleError.message} — core.list_membership_roles is not deployed to this database yet`,
          }),
        );
      } else {
        unreadable('listInternalRosterWithRoles.roles', roleError);
      }
    }

    secondaryByMembership = (roleRows ?? []).reduce((map: Map<string, string[]>, r: Record<string, unknown>) => {
      const key = String(r.membership_id);
      const list = map.get(key) ?? [];
      list.push(String(r.role));
      map.set(key, list);
      return map;
    }, new Map<string, string[]>());
  }

  return rows.map((m) => {
    const user = (m.users ?? {}) as { full_name?: string | null; email?: string | null };
    const membershipId = m.id as string;
    return {
      membershipId,
      userId: m.user_id as string,
      fullName: user.full_name ?? user.email ?? 'someone without a name on file',
      email: user.email ?? '',
      role: m.role as string,
      status: m.status as 'active' | 'suspended',
      createdAt: m.created_at as string,
      secondaryRoles: secondaryByMembership.get(membershipId) ?? [],
    };
  });
}

/**
 * What a PM can send right now — PM §10, §11; G-291.
 *
 * G-290 built `render_design_message` and left it with no caller, which is the
 * defect this phase has spent five units removing. This is its reader.
 *
 * **The refusals are the useful half.** §10's rule is that a message must not
 * claim something the state does not support, so three of the four steps can
 * be unavailable — and *"not yet, because no revised option has passed Admin"*
 * is more use to a PM than the absence of a button. So this returns a row for
 * every step, carrying either the body or the reason there isn't one.
 */
export type DesignMessage = {
  stepKey: string;
  label: string;
  body: string | null;
  blockedReason: string | null;
};

export type ProjectTeamMember = {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  tasksTotal: number;
  tasksDone: number;
};

/**
 * Who is actually working this project — SCR-025. Confirmed genuinely
 * missing by the traceability sweep: there is no `project_members` table,
 * and `listInternalRoster` above is agency-wide, not per-project. Rather than
 * inventing a membership model this reads the one fact the schema already
 * carries — `projects.tasks.assignee_id` — so the list is exactly who has
 * been assigned work here, never a name added to a roster and forgotten.
 *
 * A person can hold more than one membership row (multirole, G-310); this
 * keeps the first role `memberships` returns for them rather than repeating
 * the same person once per role, because a task assignee is one person doing
 * the work, not each of their roles doing it separately.
 */
export async function listProjectTeam(projectId: string): Promise<ProjectTeamMember[]> {
  const supabase = await createClient();

  const { data: tasks, error } = await supabase
    .schema('projects')
    .from('tasks')
    .select('assignee_id, status')
    .eq('project_id', projectId)
    .not('assignee_id', 'is', null);
  if (error) unreadable('listProjectTeam.tasks', error);

  const rows = tasks ?? [];
  const counts = new Map<string, { tasksTotal: number; tasksDone: number }>();
  for (const t of rows) {
    const userId = t.assignee_id as string;
    const entry = counts.get(userId) ?? { tasksTotal: 0, tasksDone: 0 };
    entry.tasksTotal += 1;
    if (t.status === 'done') entry.tasksDone += 1;
    counts.set(userId, entry);
  }

  const userIds = [...counts.keys()];
  if (userIds.length === 0) return [];

  const { data: memberships, error: memError } = await supabase
    .schema('core')
    .from('memberships')
    .select('user_id, role, users:user_id(full_name, email)')
    .in('user_id', userIds);
  if (memError) unreadable('listProjectTeam.memberships', memError);

  const seen = new Set<string>();
  const members: ProjectTeamMember[] = [];
  for (const m of (memberships ?? []) as Record<string, unknown>[]) {
    const userId = m.user_id as string;
    if (seen.has(userId)) continue;
    seen.add(userId);
    const user = (m.users ?? {}) as { full_name?: string | null; email?: string | null };
    const c = counts.get(userId) ?? { tasksTotal: 0, tasksDone: 0 };
    members.push({
      userId,
      fullName: user.full_name ?? user.email ?? 'someone without a name on file',
      email: user.email ?? '',
      role: m.role as string,
      tasksTotal: c.tasksTotal,
      tasksDone: c.tasksDone,
    });
  }

  return members;
}

export type ProjectFile = {
  id: string;
  category: string;
  title: string;
  url: string;
  description: string | null;
  uploadedByName: string | null;
  createdAt: string;
};

/**
 * Every file reference on a project, newest first — SCR-024.
 *
 * `uploaded_by` is fetched separately rather than embedded: it crosses from
 * `projects` into `core.users`, and PostgREST does not resolve a cross-schema
 * embed (the same reason `listProposals` in the sales module fetches its
 * lead titles as a second query rather than nesting them).
 */
export async function listProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('project_files')
    .select('id, category, title, url, description, uploaded_by, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) unreadable('listProjectFiles', error);

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.uploaded_by).filter((id): id is string => id !== null))];

  const nameByUser = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .schema('core')
      .from('users')
      .select('id, full_name, email')
      .in('id', userIds);
    if (usersError) unreadable('listProjectFiles.users', usersError);
    for (const u of users ?? []) nameByUser.set(u.id, u.full_name ?? u.email ?? 'Unknown');
  }

  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    title: r.title,
    url: r.url,
    description: r.description,
    uploadedByName: r.uploaded_by ? (nameByUser.get(r.uploaded_by) ?? null) : null,
    createdAt: r.created_at,
  }));
}

export type ProjectRepository = {
  id: string;
  name: string;
  platform: string;
  url: string;
  defaultBranch: string | null;
  reviewUrl: string | null;
  notes: string | null;
  createdAt: string;
};

/** Every repository reference on a project, newest first — SCR-042. */
export async function listRepositories(projectId: string): Promise<ProjectRepository[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('repositories')
    .select('id, name, platform, url, default_branch, review_url, notes, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) unreadable('listRepositories', error);

  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    url: r.url,
    defaultBranch: r.default_branch,
    reviewUrl: r.review_url,
    notes: r.notes,
    createdAt: r.created_at,
  }));
}

const MESSAGE_STEPS: { key: string; label: string }[] = [
  { key: 'phase_three_start', label: 'Tell them the design stage has started' },
  { key: 'theme_review', label: 'Ask them to review the options' },
  { key: 'revision_ready', label: 'Tell them the revision is ready' },
  { key: 'final_confirmation', label: 'Ask them to confirm the final choice' },
  { key: 'task_one_complete', label: 'Tell them Task 1 is complete' },
];

/** Why a step cannot be sent, in the words a PM needs rather than an outcome code. */
const NOT_YET: Record<string, string> = {
  nothing_approved: 'Not yet — nothing has passed the Admin gate, so there is nothing a client may see.',
  no_revision_ready: 'Not yet — no revised option has been delivered and approved, so this would claim something that has not happened.',
  not_selected_yet: 'Not yet — the client has not picked a direction, so there is nothing to confirm.',
  not_locked_yet: 'Not yet — the theme and color direction has not been locked, so Task 1 is not actually done.',
  bad_step: 'This step is not one this system has wording for.',
  unknown_phase: 'Phase 3 has not started for this project.',
};

export async function readDesignMessages(phaseThreeId: string): Promise<DesignMessage[]> {
  const supabase = await createClient();

  const results = await Promise.all(
    MESSAGE_STEPS.map((step) =>
      supabase.schema('projects').rpc('render_design_message', {
        p_phase_three_id: phaseThreeId,
        p_step_key: step.key,
        p_language: 'en',
      }),
    ),
  );

  return MESSAGE_STEPS.map((step, i) => {
    const { data, error } = results[i] ?? { data: null, error: null };
    // G-054 on every one. A step that rendered as "not available" because the
    // database did not answer would tell a PM their project is not ready when
    // nobody knows whether it is.
    if (error) unreadable(`readDesignMessages.${step.key}`, error);

    const row = (Array.isArray(data) ? data[0] : data) as
      | { outcome?: string; body?: string | null }
      | undefined;

    if (row?.outcome === 'rendered') {
      return { stepKey: step.key, label: step.label, body: row.body ?? null, blockedReason: null };
    }
    return {
      stepKey: step.key,
      label: step.label,
      body: null,
      blockedReason: NOT_YET[row?.outcome ?? ''] ?? 'You do not have permission to read this project’s messages.',
    };
  });
}

/**
 * Sample screens and §7's coverage — Designer §7, §17, §19; G-293.
 *
 * Two reads that belong together: what a direction has been sampled with, and
 * what §7 asks for that it has not. The second is a **report** — §7 hedges
 * both of its "at least one" rules with "when applicable", so nothing refuses
 * on it and this page says so.
 *
 * The screen picker offers only `approved` screens, because that is exactly
 * what the door accepts. A picker showing drafts would make
 * `screen_not_approved` the normal outcome of using it.
 */
export type SampleScreen = {
  id: string;
  themeOptionId: string;
  screenId: string;
  screenName: string;
  screenKey: string;
  pattern: string;
  figmaNodeId: string | null;
  previewAssetUrl: string | null;
  decisionNote: string | null;
};

export type SampleCoverage = { themeOptionId: string; sampleCount: number; unmet: string[] };

export type ApprovedScreen = { id: string; name: string; screenKey: string };

export async function readSampleScreens(
  projectId: string,
  themeOptionIds: string[],
): Promise<{ samples: SampleScreen[]; coverage: SampleCoverage[]; approvedScreens: ApprovedScreen[] }> {
  const supabase = await createClient();

  const [{ data: samples, error: samplesError }, { data: screens, error: screensError }] =
    await Promise.all([
      supabase
        .schema('projects')
        .from('representative_screens')
        .select('id, theme_option_id, screen_id, pattern, figma_node_id, preview_asset_url, decision_note, screens:screen_id(name, screen_key)')
        .eq('project_id', projectId)
        .order('pattern', { ascending: true }),
      supabase
        .schema('projects')
        .from('screens')
        .select('id, name, screen_key')
        .eq('project_id', projectId)
        .eq('status', 'approved')
        .order('screen_key', { ascending: true }),
    ]);

  // G-054 on both. An empty sample list on a failed read would say this
  // direction was never demonstrated, which is a statement about somebody's
  // work rather than about the database.
  if (samplesError) unreadable('readSampleScreens.samples', samplesError);
  if (screensError) unreadable('readSampleScreens.approved', screensError);

  const coverageRows = await Promise.all(
    themeOptionIds.map((id) =>
      supabase.schema('projects').rpc('representative_coverage', { p_theme_option_id: id }),
    ),
  );

  const coverage: SampleCoverage[] = themeOptionIds.map((id, i) => {
    const { data, error } = coverageRows[i] ?? { data: null, error: null };
    if (error) unreadable('readSampleScreens.coverage', error);
    const row = (Array.isArray(data) ? data[0] : data) as
      | { sample_count?: number; unmet?: string[] | null }
      | undefined;
    return { themeOptionId: id, sampleCount: row?.sample_count ?? 0, unmet: row?.unmet ?? [] };
  });

  return {
    samples: ((samples ?? []) as Record<string, unknown>[]).map((r) => {
      const screen = (r.screens ?? {}) as { name?: string | null; screen_key?: string | null };
      return {
        id: r.id as string,
        themeOptionId: r.theme_option_id as string,
        screenId: r.screen_id as string,
        screenName: screen.name ?? 'a screen',
        screenKey: screen.screen_key ?? '',
        pattern: r.pattern as string,
        figmaNodeId: (r.figma_node_id as string | null) ?? null,
        previewAssetUrl: (r.preview_asset_url as string | null) ?? null,
        decisionNote: (r.decision_note as string | null) ?? null,
      };
    }),
    coverage,
    approvedScreens: ((screens ?? []) as Record<string, unknown>[]).map((s) => ({
      id: s.id as string,
      name: s.name as string,
      screenKey: s.screen_key as string,
    })),
  };
}

/**
 * A direction's Phase 3 primitives — Designer §4.5, §19, §23; G-296.
 *
 * The newest set per theme, whatever its status. The form shows the current
 * values as defaults, so somebody editing changes what they mean to change and
 * leaves the rest — which is exactly what the door's carry-forward provides,
 * and pointless if the surface presents empty boxes.
 */
export type TokenSet = {
  themeOptionId: string;
  id: string;
  version: number;
  status: string;
  fontFamilyHeading: string | null;
  fontFamilyBody: string | null;
  typeScaleRatio: string | null;
  baseSpacingPx: number | null;
  radiusStyle: string | null;
  elevationStyle: string | null;
  borderStyle: string | null;
  iconTreatment: string | null;
  navigationStyle: string | null;
  buttonTreatment: string | null;
  cardTreatment: string | null;
  notes: string | null;
};

export async function readTokenSets(projectId: string): Promise<TokenSet[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('design_token_sets')
    .select('id, theme_option_id, version, status, font_family_heading, font_family_body, type_scale_ratio, base_spacing_px, radius_style, elevation_style, border_style, icon_treatment, navigation_style, button_treatment, card_treatment, notes')
    .eq('project_id', projectId)
    .order('version', { ascending: false });
  // G-054. An empty list on a failed read would present blank boxes as the
  // current state, and the first edit would look like it dropped everything.
  if (error) unreadable('readTokenSets', error);

  const rows = (data ?? []) as Record<string, unknown>[];
  const newest = new Map<string, TokenSet>();
  for (const r of rows) {
    const theme = r.theme_option_id as string;
    // Ordered newest-first, so the first one seen per theme is the current one.
    if (newest.has(theme)) continue;
    newest.set(theme, {
      themeOptionId: theme,
      id: r.id as string,
      version: r.version as number,
      status: r.status as string,
      fontFamilyHeading: (r.font_family_heading as string | null) ?? null,
      fontFamilyBody: (r.font_family_body as string | null) ?? null,
      typeScaleRatio: r.type_scale_ratio === null || r.type_scale_ratio === undefined
        ? null
        : String(r.type_scale_ratio),
      baseSpacingPx: (r.base_spacing_px as number | null) ?? null,
      radiusStyle: (r.radius_style as string | null) ?? null,
      elevationStyle: (r.elevation_style as string | null) ?? null,
      borderStyle: (r.border_style as string | null) ?? null,
      iconTreatment: (r.icon_treatment as string | null) ?? null,
      navigationStyle: (r.navigation_style as string | null) ?? null,
      buttonTreatment: (r.button_treatment as string | null) ?? null,
      cardTreatment: (r.card_treatment as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
    });
  }
  return [...newest.values()];
}

/**
 * Designer §9 — AI-generated reference imagery, optional support for the
 * design workflow and never a canonical artifact (G-308, ADM-111). At most
 * one per design context version, by the door's own idempotency, so this is
 * a short list rather than a paginated one.
 */
export type DesignAsset = {
  id: string;
  kind: string;
  prompt: string;
  imageBase64: string;
  mediaType: string;
  model: string;
  rightsNote: string;
  createdAt: string;
};

export async function readDesignAssets(projectId: string): Promise<DesignAsset[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('design_assets')
    .select('id, kind, prompt, image_base64, media_type, model, rights_note, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  // G-054. An empty list on a failed read would say no reference was ever
  // drawn, which is a claim about the workflow rather than about the read.
  if (error) unreadable('readDesignAssets', error);

  return (data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    prompt: r.prompt,
    imageBase64: r.image_base64,
    mediaType: r.media_type,
    model: r.model,
    rightsNote: r.rights_note,
    createdAt: r.created_at,
  }));
}

/**
 * What a project spent, by phase — Master §6, §8; Designer §23; G-298.
 *
 * G-297 made the spend attributable and left `ai.project_usage_by_phase` with
 * no caller. This is it.
 *
 * **The unattributed line is kept, not dropped.** A report that showed only
 * the phases it could name would understate the total, and understating spend
 * is the direction that matters — somebody reading it would believe the
 * project cost less than it did. It comes back with `phase: null` and the
 * surface labels it.
 */
export type PhaseSpend = {
  phase: number | null;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
};

export async function readProjectSpend(projectId: string): Promise<PhaseSpend[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .rpc('project_usage_by_phase', { p_project_id: projectId });
  // G-054. "Nothing has been spent" and "the database did not answer" are
  // different statements, and only one of them is about money.
  if (error) unreadable('readProjectSpend', error);

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    phase: (r.phase as number | null) ?? null,
    runs: Number(r.runs ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    costMinor: Number(r.cost_minor ?? 0),
  }));
}

export type MyTaskRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueOn: string | null;
  projectId: string;
  projectName: string;
};

/**
 * SCR-021 — everything assigned to the signed-in user, across every
 * project. `projects.tasks` and its `assignee_id` column have existed since
 * the schema was written (20260807120006); this is their first cross-project
 * reader — `readPlanBoard` and the development breakdown both scope tasks to
 * one project, which is the right shape for those screens and the wrong one
 * for "what do I personally owe".
 */
export async function listMyTasks(userId: string): Promise<MyTaskRow[]> {
  const supabase = await createClient();

  const { data: taskRows, error: tasksError } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, title, status, priority, due_on, project_id')
    .eq('assignee_id', userId)
    .neq('status', 'done')
    .order('due_on', { ascending: true, nullsFirst: false });

  if (tasksError) unreadable('listMyTasks.tasks', tasksError);

  const rows = taskRows ?? [];
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((t) => t.project_id))];
  const { data: projectRows, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name')
    .in('id', projectIds);

  if (projectsError) unreadable('listMyTasks.projects', projectsError);

  const nameById = new Map((projectRows ?? []).map((p) => [p.id, p.name]));

  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueOn: t.due_on,
    projectId: t.project_id,
    projectName: nameById.get(t.project_id) ?? 'Unknown project',
  }));
}
