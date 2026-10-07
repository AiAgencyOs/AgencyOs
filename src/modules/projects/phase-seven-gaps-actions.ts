'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * Phase 7 gap-closure forms: a corrective action (a real task), the follow-up schedule after completion, and a production health snapshot a person
 * records. Each calls a database DOOR as the signed-in person and reports the door's answer; the doors own the rules. Nothing here sends a message,
 * deploys, contacts a monitor or decides a state.
 */

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const nothing = (v: string): string | null => (v === '' ? null : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Rpc = { schema(name: string): { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> } };

const WORDS: Record<string, string> = {
  not_authorized: 'You do not have permission to do that.',
  not_found: 'That record was not found.',
  title_required: 'Give the corrective action a title.',
  title_too_long: 'That title is too long.',
  contains_secret: 'Name the variable, never its value.',
  assignee_not_in_organization: 'The assignee must belong to this organization.',
  already_recorded: 'That corrective action is already recorded.',
  not_completed: 'The project has not completed, so there is nothing to follow up yet.',
  nothing_to_schedule: 'Every follow-up that can be scheduled already is.',
  bad_status: 'Choose healthy, degraded, down or unknown.',
  evidence_required: 'Name the evidence for this snapshot.',
  deployment_not_found: 'That deployment is not on this project.',
};
const words = (outcome: string) => WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`;

async function callDoor(fn: string, args: Record<string, unknown>, good: readonly string[], success: (row: Record<string, unknown>) => string, projectId: string): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write') || !context.organizationId) return { status: 'error', message: 'You do not have permission to change this project.' };
  const supabase = (await createClient()) as unknown as Rpc;
  const { data, error } = await supabase.schema('projects').rpc(fn, args);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was changed.' };
  const row = ((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null) ?? {};
  const outcome = String(row.outcome ?? 'no answer');
  if (!good.includes(outcome)) return { status: 'error', message: words(outcome) };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: success(row) };
}

export async function addIncidentCorrectiveActionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const incidentId = text(formData, 'incidentId');
  const assignee = text(formData, 'assigneeId');
  if (!UUID.test(projectId) || !UUID.test(incidentId) || (assignee !== '' && !UUID.test(assignee))) return { status: 'error', message: 'That record was not found.' };
  return callDoor('add_incident_corrective_action', { p_incident_id: incidentId, p_title: text(formData, 'title'), p_assignee_id: nothing(assignee), p_due_on: nothing(text(formData, 'dueOn')) },
    ['created'], () => 'Corrective action created as a task on the project.', projectId);
}

export async function scheduleHandoverFollowUpsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  if (!UUID.test(projectId)) return { status: 'error', message: 'That record was not found.' };
  return callDoor('schedule_handover_follow_ups', { p_project_id: projectId }, ['scheduled'],
    (row) => `Scheduled ${String(row.created ?? 0)} follow-up task(s).${Array.isArray(row.skipped) && row.skipped.length ? ` Not scheduled: ${(row.skipped as string[]).join('; ')}.` : ''}`, projectId);
}

export async function recordProductionHealthSnapshotAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const deployment = text(formData, 'deploymentId');
  if (!UUID.test(projectId) || (deployment !== '' && !UUID.test(deployment))) return { status: 'error', message: 'That record was not found.' };
  const flag = (key: string): boolean | null => (text(formData, key) === 'yes' ? true : text(formData, key) === 'no' ? false : null);
  return callDoor('record_production_health_snapshot', {
    p_project_id: projectId, p_status: text(formData, 'status'), p_evidence_ref: text(formData, 'evidenceRef'), p_error_summary: nothing(text(formData, 'errorSummary')),
    p_integrations_ok: flag('integrationsOk'), p_database_ok: flag('databaseOk'), p_deployment_id: nothing(deployment), p_commit_ref: nothing(text(formData, 'commitRef')),
  }, ['recorded'], () => 'Snapshot recorded as a manual note: no monitoring source is connected.', projectId);
}
