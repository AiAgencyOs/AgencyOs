import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Admin reads for the Phase 4 QA / PM / Finance / Orchestrator records (migrations 20261126*). Every one is a database read function that returns nothing to a caller
 * who may not read it, so an empty result means "not shown", never "all clear". db:types is generated from a running database; until it is regenerated these
 * are called through a loose view of the client.
 */
type Loose = {
  schema(name: string): {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
    from(table: string): {
      select(columns: string): {
        eq(column: string, value: string): { order(column: string, opts: { ascending: boolean }): PromiseLike<{ data: unknown; error: { message: string } | null }> };
      };
    };
  };
};

async function client(): Promise<Loose> {
  return (await createClient()) as unknown as Loose;
}

export type QaOverviewRow = {
  artifact_id: string;
  deliverable_id: string;
  ui_version: number;
  built_at: string;
  qa_state: string;
  owner: string;
  blocker: string | null;
  blocker_id: string | null;
  latest_run_id: string | null;
  latest_run_at: string | null;
  checks_failed: number | null;
  why: string | null;
};

export async function readPrototypeQaOverview(projectId: string): Promise<QaOverviewRow[]> {
  const { data, error } = await (await client()).schema('projects').rpc('p4q_prototype_qa_overview', { p_project_id: projectId });
  if (error) unreadable('readPrototypeQaOverview', error);
  return (data ?? []) as QaOverviewRow[];
}

export async function readPrototypeAdminHandoff(artifactId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await (await client()).schema('projects').rpc('p4q_prototype_admin_handoff', { p_artifact_id: artifactId });
  if (error) unreadable('readPrototypeAdminHandoff', error);
  return (data ?? null) as Record<string, unknown> | null;
}

export type RevisionRecordRow = {
  artifact_kind: string;
  from_version: number | null;
  to_version: number | null;
  origin: string;
  normalised_changes: string | null;
  affected_screens: string[];
  qa_result: string | null;
  classification: string | null;
  admin_decision: string | null;
  client_decision: string | null;
};

export async function readRevisionRecords(projectId: string): Promise<RevisionRecordRow[]> {
  const { data, error } = await (await client()).schema('projects').rpc('p4q_revision_records', { p_project_id: projectId });
  if (error) unreadable('readRevisionRecords', error);
  return (data ?? []) as RevisionRecordRow[];
}

export type TraceRow = { at: string; source: string; kind: string; from_agent: string | null; to_agent: string | null; summary: string; ref_id: string };

export async function readPhaseFourTrace(projectId: string): Promise<TraceRow[]> {
  const { data, error } = await (await client()).schema('projects').rpc('p4q_phase4_trace', { p_project_id: projectId });
  if (error) unreadable('readPhaseFourTrace', error);
  return (data ?? []) as TraceRow[];
}

export type FailureQueueRow = { envelope_id: string; task_type: string; agent_key: string; status: string; attempts: number; retry_budget: number; last_class: string; last_detail: string; last_at: string };

export async function readFailureQueue(projectId: string): Promise<FailureQueueRow[]> {
  const { data, error } = await (await client()).schema('projects').rpc('p4q_failure_queue', { p_project_id: projectId });
  if (error) unreadable('readFailureQueue', error);
  return (data ?? []) as FailureQueueRow[];
}

export type M2OverviewRow = { milestone_id: string; payment_percent: number; amount_minor: number; trigger_state: string; invoice_status: string | null; due_at: string | null; balance_minor: number; gate: string; baseline: string };

export async function readM2Overview(projectId: string): Promise<M2OverviewRow | null> {
  const { data, error } = await (await client()).schema('finance').rpc('p4q_m2_overview', { p_project_id: projectId });
  if (error) unreadable('readM2Overview', error);
  return ((data ?? []) as M2OverviewRow[])[0] ?? null;
}

export type ReminderRow = { invoice_number: string; stage: string; state: string; attempts: number; scheduled_for: string; note: string | null };

export async function readReminderOverview(projectId: string): Promise<ReminderRow[]> {
  const { data, error } = await (await client()).schema('finance').rpc('p4q_reminder_overview', { p_project_id: projectId });
  if (error) unreadable('readReminderOverview', error);
  return (data ?? []) as ReminderRow[];
}

export type EscalationRow = { id: string; cause: string; owner: string; reason: string; state: string; decision: string | null; opened_at: string; raised_by_agent: string | null };

export async function readEscalations(projectId: string): Promise<EscalationRow[]> {
  const { data, error } = await (await client())
    .schema('projects')
    .from('p4q_escalations')
    .select('id, cause, owner, reason, state, decision, opened_at, raised_by_agent')
    .eq('project_id', projectId)
    .order('opened_at', { ascending: false });
  if (error) unreadable('readEscalations', error);
  return (data ?? []) as EscalationRow[];
}

export type ShareRow = { id: string; kind: string; channel: string; delivery_state: string; delivery_evidence: string | null; retry_count: number; shared_at: string };

export async function readClientReviewShares(projectId: string): Promise<ShareRow[]> {
  const { data, error } = await (await client())
    .schema('projects')
    .from('p4q_client_review_shares')
    .select('id, kind, channel, delivery_state, delivery_evidence, retry_count, shared_at')
    .eq('project_id', projectId)
    .order('shared_at', { ascending: false });
  if (error) unreadable('readClientReviewShares', error);
  return (data ?? []) as ShareRow[];
}

export type ValidationCheckRow = { check_key: string; category: string; target: string; result: string; severity: string; disposition: string | null; actual: string };

export async function readValidationMatrix(runId: string): Promise<ValidationCheckRow[]> {
  const { data, error } = await (await client())
    .schema('projects')
    .from('p4q_prototype_qa_checks')
    .select('check_key, category, target, result, severity, disposition, actual')
    .eq('run_id', runId)
    .order('check_key', { ascending: true });
  if (error) unreadable('readValidationMatrix', error);
  return (data ?? []) as ValidationCheckRow[];
}

export type AwaitingVerificationRow = { defect_id: string; title: string; check_key: string; fix_artifact_id: string; retest_run_id: string };

export async function readDefectsAwaitingVerification(projectId: string): Promise<AwaitingVerificationRow[]> {
  const { data, error } = await (await client()).schema('projects').rpc('p4q_defects_awaiting_verification', { p_project_id: projectId });
  if (error) unreadable('readDefectsAwaitingVerification', error);
  return (data ?? []) as AwaitingVerificationRow[];
}

export type UiVersionForShare = { id: string; version: number; status: string };

export async function readUiVersionsForShare(projectId: string): Promise<UiVersionForShare[]> {
  const { data, error } = await (await client())
    .schema('projects')
    .from('ui_versions')
    .select('id, version, status')
    .eq('project_id', projectId)
    .order('version', { ascending: false });
  if (error) unreadable('readUiVersionsForShare', error);
  return ((data ?? []) as UiVersionForShare[]).filter((v) => v.status === 'admin_approved' || v.status === 'client_review');
}
