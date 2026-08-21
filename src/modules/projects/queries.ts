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
