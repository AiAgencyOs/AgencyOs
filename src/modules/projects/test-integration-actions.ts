'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * Admin actions for the Test Automation and Documentation agents and for the test/integration doors (a regression link, a task's dependency on an
 * integration).
 *
 * Asking an agent is ENQUEUEING a job: the Admin chooses what the agent looks at, and the agent only drafts (see
 * app/api/jobs/run/specialist-workflows.ts). No event in the catalog says "documents are due" or "this task is ready to be tested" without also
 * firing for work the agent was not asked to do, so these two are not event-driven. The subject is read through the caller's OWN session first, so a
 * project or task of another organization is simply not found; the job is then queued for the CALLER's organization.
 */

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One request per subject per minute: a double click is one job, a deliberate second request a minute later is allowed. */
const dedupeKey = (kind: string, subject: string) => `${kind}:${subject}:${Math.floor(Date.now() / 60_000)}`;

async function gate(): Promise<{ organizationId: string } | FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write') || !context.organizationId) return { status: 'error', message: 'You do not have permission to change this project.' };
  return { organizationId: context.organizationId };
}

async function enqueue(kind: string, subject: { table: 'projects' | 'tasks'; id: string; projectId: string }, payload: Record<string, string>, queued: string): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  if (!UUID.test(subject.id)) return { status: 'error', message: 'That record was not found.' };
  const supabase = await createClient();
  // the row must belong to the project the form named (a task of another project is not found)
  const base = supabase.schema('projects').from(subject.table).select('id').eq('id', subject.id);
  const { data, error } = await (subject.table === 'tasks' ? base.eq('project_id', subject.projectId) : base).maybeSingle();
  if (error) return { status: 'error', message: 'The record could not be read; nothing was queued.' };
  if (!data) return { status: 'error', message: 'That record was not found.' };
  const admin = createAdminClient();
  const { error: insertError } = await admin.schema('core').from('jobs').insert({
    organization_id: g.organizationId,
    kind,
    payload,
    dedupe_key: dedupeKey(kind, subject.id),
  });
  // a unique violation is the same request made twice in a minute: it is already queued
  if (insertError && insertError.code !== '23505') return { status: 'error', message: 'The request could not be queued.' };
  revalidatePath(`/projects/${subject.projectId}`);
  return { status: 'success', message: queued };
}

/** Ask the Documentation agent for a DRAFT of this project's documentation. It documents only what the records show, and it never marks anything implemented. */
export async function requestDocumentationDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  return enqueue('documentation.draft', { table: 'projects', id: projectId, projectId }, { projectId }, 'Asked the Documentation agent. Its draft appears under Documents as partial, for a person to review.');
}

/** Ask the Test Automation agent to PROPOSE test cases for one task. A proposal is not a test, a run or a result. */
export async function requestTestCaseDraftsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const taskId = text(formData, 'taskId');
  return enqueue('test_automation.propose_cases', { table: 'tasks', id: taskId, projectId }, { taskId, projectId }, 'Asked the Test Automation agent. Its proposed cases appear as drafts for a person to accept.');
}

const WORDS: Record<string, string> = {
  linked: 'Linked: the defect now has its regression test.',
  already_linked: 'That defect is already linked to that test.',
  recorded: 'Recorded.',
  already_depends: 'That task already depends on that integration.',
  released: 'The dependency was removed.',
  not_authorized: 'You do not have permission to do this.',
  not_found: 'That record was not found.',
  bad_name: 'Name the automated test.',
  bad_build: 'The defective build must be a build of this project.',
  wrong_project: 'The task and the integration belong to different projects.',
};

async function door(projectId: string, schema: 'qa' | 'projects', rpc: string, args: Record<string, unknown>, ok: readonly string[]): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const supabase = await createClient();
  const { data, error } = await supabase.schema(schema).rpc(rpc as never, args as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | null;
  const outcome = String(row?.outcome ?? 'no answer');
  if (!ok.includes(outcome)) return { status: 'error', message: WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: WORDS[outcome] ?? 'Done.' };
}

/** Link a defect to the automated test that keeps it fixed. */
export async function linkRegressionTestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return door(text(formData, 'projectId'), 'qa', 'link_regression_test', {
    p_defect_id: text(formData, 'defectId'),
    p_test_case_name: text(formData, 'testCaseName'),
    p_defective_deliverable_id: text(formData, 'defectiveBuildId') || null,
  }, ['linked', 'already_linked']);
}

/** Declare that a task cannot work without an integration: if that integration degrades, this task (and only the tasks that depend on it) is blocked. */
export async function dependTaskOnIntegrationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return door(text(formData, 'projectId'), 'projects', 'depend_task_on_integration', {
    p_task_id: text(formData, 'taskId'),
    p_connection_id: text(formData, 'connectionId'),
  }, ['recorded', 'already_depends']);
}
