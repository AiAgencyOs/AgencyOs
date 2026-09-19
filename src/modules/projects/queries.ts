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
  };

  // No plan is not a failed read: most projects have never had one drafted,
  // and the page's whole job in that case is to offer to start one.
  if (!planRow) return empty;

  const [deliverables, milestones, dependencies, notes, clarifications] = await Promise.all([
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
  ]);

  // Five reads, five refusals. A register that failed to load is not an empty
  // register: a plan missing its risks reads as a plan with no risks, and
  // somebody activates it.
  const boardError =
    deliverables.error ?? milestones.error ?? dependencies.error ?? notes.error ?? clarifications.error;
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
    figmaNodeId: string | null;
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
      .select('id, option_index, name, direction_summary, version, origin, internal_review_status, admin_status, client_status, figma_node_id, figma_version, preview_asset_url')
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
      figmaNodeId: (t.figma_node_id as string | null) ?? null,
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
