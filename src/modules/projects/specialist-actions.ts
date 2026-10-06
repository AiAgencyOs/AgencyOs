'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import { developmentSpecialistJobKind, isDevelopmentSpecialist } from './specialist-proposals';

/**
 * "Ask the specialist": an Admin asks the specialist a task was ROUTED to for an implementation PROPOSAL. Asking is enqueueing a job; the specialist only
 * proposes (app/api/jobs/run/development-specialist-workflows.ts) and a person and QA decide what the proposal becomes.
 *
 * The task is read through the caller's OWN session, so a task of another organization is simply not found, and it must already have a handoff to the
 * specialist its plan names: a held or refused task is not asked about, and the specialist is never chosen by the caller (it is the task's
 * `required_capability`). The job is queued for the CALLER's organization.
 */

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One request per task per minute: a double click is one job. */
const dedupeKey = (kind: string, subject: string) => `${kind}:${subject}:${Math.floor(Date.now() / 60_000)}`;

export async function requestSpecialistProposalAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const taskId = text(formData, 'taskId');
  const projectId = text(formData, 'projectId');
  const context = await requireInternal();
  if (!can(context, 'project.write') || !context.organizationId) return { status: 'error', message: 'You do not have permission to change this project.' };
  if (!UUID.test(taskId) || !UUID.test(projectId)) return { status: 'error', message: 'That task was not found.' };

  const supabase = await createClient();
  const task = await supabase.schema('projects').from('tasks').select('id, project_id, required_capability, status').eq('id', taskId).eq('project_id', projectId).maybeSingle();
  if (task.error) return { status: 'error', message: 'The task could not be read; nothing was queued.' };
  if (!task.data) return { status: 'error', message: 'That task was not found.' };
  const agent = task.data.required_capability;
  if (!agent || !isDevelopmentSpecialist(agent)) return { status: 'error', message: 'This task names no development specialist; planning must assign one first.' };
  if (task.data.status === 'cancelled') return { status: 'error', message: 'This task was cancelled.' };

  const routed = await supabase.schema('ai').from('handoffs').select('id').eq('subject_type', 'development_task').eq('subject_id', taskId).eq('to_agent', agent).limit(1);
  if (routed.error) return { status: 'error', message: 'The routing record could not be read; nothing was queued.' };
  if ((routed.data ?? []).length === 0) return { status: 'error', message: 'This task has not been routed to its specialist yet (it may be held), so there is nothing to ask about.' };

  const kind = developmentSpecialistJobKind(agent);
  const admin = createAdminClient();
  const { error } = await admin.schema('core').from('jobs').insert({
    organization_id: context.organizationId,
    kind,
    payload: { taskId, projectId },
    dedupe_key: dedupeKey(kind, taskId),
  });
  // a unique violation is the same request made twice in a minute: it is already queued
  if (error && error.code !== '23505') return { status: 'error', message: 'The request could not be queued.' };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Asked the specialist. Its proposal appears below as a plan for a person to review; it changes no code and records no test.' };
}
