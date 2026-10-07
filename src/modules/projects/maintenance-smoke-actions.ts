'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * Staff actions for a failed post-deploy smoke check (Phase 8B). Each calls a database DOOR as the signed-in person and shows the door's answer in words.
 * The person's own identity is what the doors check (Admin-only decision, reporter != decider). AgencyOS runs no smoke check and rolls nothing back:
 * these record what a person observed and what an Admin decided happened elsewhere.
 */

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORDS: Record<string, string> = {
  no_actor: 'Sign in again.',
  not_authorized: 'You do not have permission to do that.',
  evidence_required: 'Give the evidence reference and say what failed.',
  invalid_severity: 'Choose minor, major or critical.',
  secret_refused: 'That looks like a secret. Paste a reference to the evidence, not the secret.',
  not_found: 'That record was not found.',
  not_released: 'Only a change that has been recorded as released can have a failed smoke check.',
  already_open: 'A failure is already open for this change: decide it first.',
  invalid_decision: 'Choose what was decided.',
  note_required: 'Say why in a note.',
  already_decided: 'That failure has already been decided.',
  self_decision: 'The person who reported the failure cannot decide it. Ask another Admin.',
};

type Rpc = { schema(name: string): { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> } };

async function call(fn: string, args: Record<string, unknown>, good: string, success: string, projectId: string): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write') || !context.organizationId) return { status: 'error', message: 'You do not have permission to change this project.' };
  const supabase = (await createClient()) as unknown as Rpc;
  const { data, error } = await supabase.schema('projects').rpc(fn, args);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was changed.' };
  const row = ((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null) ?? null;
  const outcome = String(row?.outcome ?? 'no answer');
  if (outcome !== good) return { status: 'error', message: WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: success };
}

export async function reportSmokeFailureAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const id = text(formData, 'workItemId');
  if (!UUID.test(projectId) || !UUID.test(id)) return { status: 'error', message: 'That record was not found.' };
  return call('report_maintenance_smoke_failure', { p_work_item_id: id, p_evidence_ref: text(formData, 'evidenceRef'), p_reason: text(formData, 'reason'), p_severity: text(formData, 'severity') || 'major' },
    'reported', 'The failure is recorded. Nothing was rolled back by AgencyOS: an Admin records what was decided.', projectId);
}

export async function decideSmokeFailureAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const id = text(formData, 'failureId');
  if (!UUID.test(projectId) || !UUID.test(id)) return { status: 'error', message: 'That record was not found.' };
  return call('decide_maintenance_smoke_failure', { p_failure_id: id, p_decision: text(formData, 'decision'), p_note: text(formData, 'note') }, 'decided', 'The decision is recorded.', projectId);
}
