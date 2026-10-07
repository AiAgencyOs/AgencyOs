import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Phase 8A second-half reads (next-action queue, metric reconciliation, feedback, goals, contact preferences, cadence). Every read goes through the signed-in
 * person's client, so row security and the internal-only guards in the functions apply. A failed read is refused (G-054): an empty queue must mean nothing
 * is waiting, and a reconciliation that could not be read must never look reconciled.
 */

export type NextAction = { kind: string; projectId: string; projectName: string; refId: string; dueAt: string | null; priority: number; summary: string };
export type ReconciliationRow = { check: string; observability: number; overview: number; reconciled: boolean; note: string | null };
export type FeedbackRow = { id: string; source: string; sentiment: string; summary: string; occurredAt: string };
export type GoalRow = { id: string; goal: string; status: string; statusNote: string | null; createdAt: string };
export type ContactPreference = { preferredChannel: string | null; avoidChannels: string[]; language: string | null; note: string | null };
export type CategoryCadence = { purpose: string; minGapDays: number };

const rows = (data: unknown): Record<string, unknown>[] => (Array.isArray(data) ? (data as Record<string, unknown>[]) : []);

export async function readNextActions(): Promise<NextAction[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('customer_success_next_actions' as never, {} as never);
  if (error) unreadable('readNextActions', error);
  return rows(data).map((r) => ({
    kind: String(r.action_kind), projectId: String(r.project_id), projectName: String(r.project_name ?? ''), refId: String(r.ref_id),
    dueAt: typeof r.due_at === 'string' ? r.due_at : null, priority: Number(r.priority ?? 9), summary: String(r.summary ?? ''),
  }));
}

export async function readReconciliation(): Promise<ReconciliationRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('reconcile_phase_eight_metrics' as never, {} as never);
  if (error) unreadable('readReconciliation', error);
  return rows(data).map((r) => ({
    check: String(r.check_name), observability: Number(r.observability_value ?? 0), overview: Number(r.overview_value ?? 0), reconciled: r.reconciled === true,
    note: typeof r.note === 'string' ? r.note : null,
  }));
}

export async function readProjectFeedback(projectId: string): Promise<FeedbackRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('client_feedback' as never).select('id, source, sentiment, summary, occurred_at').eq('project_id' as never, projectId as never).order('occurred_at' as never, { ascending: false }).limit(50);
  if (error) unreadable('readProjectFeedback', error);
  return rows(data).map((r) => ({ id: String(r.id), source: String(r.source), sentiment: String(r.sentiment), summary: String(r.summary), occurredAt: String(r.occurred_at) }));
}

export async function readProjectGoals(projectId: string): Promise<GoalRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('client_goals' as never).select('id, goal, status, status_note, created_at').eq('project_id' as never, projectId as never).order('created_at' as never, { ascending: false }).limit(50);
  if (error) unreadable('readProjectGoals', error);
  return rows(data).map((r) => ({ id: String(r.id), goal: String(r.goal), status: String(r.status), statusNote: typeof r.status_note === 'string' ? r.status_note : null, createdAt: String(r.created_at) }));
}

export async function readContactPreference(clientId: string): Promise<ContactPreference | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('client_contact_preferences' as never).select('preferred_channel, avoid_channels, language, note').eq('client_account_id' as never, clientId as never).maybeSingle();
  if (error) unreadable('readContactPreference', error);
  const r = data as Record<string, unknown> | null;
  if (!r) return null;
  return { preferredChannel: typeof r.preferred_channel === 'string' ? r.preferred_channel : null, avoidChannels: Array.isArray(r.avoid_channels) ? (r.avoid_channels as string[]) : [], language: typeof r.language === 'string' ? r.language : null, note: typeof r.note === 'string' ? r.note : null };
}

export async function readCategoryCadence(): Promise<CategoryCadence[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('communication_category_cadence' as never).select('purpose, min_gap_days').eq('active' as never, true as never);
  if (error) unreadable('readCategoryCadence', error);
  return rows(data).map((r) => ({ purpose: String(r.purpose), minGapDays: Number(r.min_gap_days) }));
}

export type LiveAccount = { projectId: string; name: string; clientAccountId: string | null };

/** The live (not closed) Phase 8 workspaces with their project names, for the record forms' selector. */
export async function readLiveAccounts(): Promise<LiveAccount[]> {
  const supabase = await createClient();
  const { data: ws, error: wsError } = await supabase.schema('projects').from('phase_eight' as never).select('project_id').neq('state' as never, 'closed' as never).limit(200);
  if (wsError) unreadable('readLiveAccounts.workspaces', wsError);
  const ids = rows(ws).map((r) => String(r.project_id));
  if (ids.length === 0) return [];
  const { data: ps, error: pError } = await supabase.schema('projects').from('projects').select('id, name, client_account_id').in('id', ids);
  if (pError) unreadable('readLiveAccounts.projects', pError);
  return rows(ps).map((r) => ({ projectId: String(r.id), name: String(r.name ?? ''), clientAccountId: typeof r.client_account_id === 'string' ? r.client_account_id : null }));
}
