'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { REVIEW_EVENTS } from './git-write-schema';
import { ACCESS_LEVELS, MERGE_ROLES, type AccessLevel, type MergeRole } from './repository-policy';
import { createTaskBranch, dispatchEnvironmentChecks, linkCommit, mergePullRequest, refreshEnvironmentChecks, setRepositoryPolicy, setRepositoryWorkflow, submitReview, triggerBuild } from './git-write-service';

/** Git is written — Decision: reversed by the owner on 2026-09-30. The Repository, Builds and task pages' controls. */

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');

function revalidateGit(projectId: string, taskId?: string) {
  revalidatePath(`/projects/${projectId}/repository`);
  revalidatePath(`/projects/${projectId}/builds`);
  revalidatePath(`/projects/${projectId}/development`);
  if (taskId) revalidatePath(`/projects/${projectId}/development/tasks/${taskId}`);
  revalidatePath('/development');
}

export async function createTaskBranchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const result = await createTaskBranch({ projectId, taskId });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateGit(projectId, taskId);
  return { status: 'success', message: `Branch ${result.data.branch} created on GitHub.` };
}

export async function submitReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const event = str(formData, 'event');
  const result = await submitReview({
    projectId,
    pullNumber: str(formData, 'pullNumber'),
    event: (REVIEW_EVENTS as readonly string[]).includes(event) ? (event as (typeof REVIEW_EVENTS)[number]) : ('' as (typeof REVIEW_EVENTS)[number]),
    body: str(formData, 'body'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateGit(projectId);
  return { status: 'success', message: `Review submitted (${result.data.state.toLowerCase().replace(/_/g, ' ')}).` };
}

export async function mergePullRequestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await mergePullRequest({ projectId, pullNumber: str(formData, 'pullNumber') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateGit(projectId);
  return { status: 'success', message: `Merged (squash) as ${result.data.sha.slice(0, 7)}.` };
}

export async function linkCommitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const taskId = str(formData, 'taskId');
  const result = await linkCommit({
    projectId,
    taskId,
    sha: str(formData, 'sha'),
    url: str(formData, 'url').trim() || undefined,
    message: str(formData, 'message').trim() || undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateGit(projectId, taskId);
  return { status: 'success', message: result.data.existed ? 'That commit was already linked to this task.' : 'Commit linked to the task.' };
}

export async function triggerBuildAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await triggerBuild({ projectId, note: str(formData, 'note').trim() || undefined });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateGit(projectId);
  return {
    status: 'success',
    message: result.data.dispatched
      ? `Build recorded and ${result.data.workflowFile} dispatched on GitHub Actions.`
      : 'Build trigger recorded. No workflow file is linked, so nothing was dispatched.',
  };
}

export async function setRepositoryWorkflowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await setRepositoryWorkflow({ projectId, workflowFile: str(formData, 'workflowFile') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateGit(projectId);
  return { status: 'success', message: result.data.workflowFile ? `Build trigger dispatches ${result.data.workflowFile}.` : 'Workflow file cleared; a build trigger is recorded only.' };
}

/** SCR-042 — the repository's access level and merge policy, from the Repository tab's policy card. */
export async function setRepositoryPolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const accessLevel = str(formData, 'accessLevel');
  const mergeRole = str(formData, 'mergeRole');
  const result = await setRepositoryPolicy({
    projectId,
    accessLevel: (ACCESS_LEVELS as readonly string[]).includes(accessLevel) ? (accessLevel as AccessLevel) : ('' as AccessLevel),
    mergeMinApprovals: Number(str(formData, 'mergeMinApprovals') || 0),
    mergeRole: (MERGE_ROLES as readonly string[]).includes(mergeRole) ? (mergeRole as MergeRole) : ('' as MergeRole),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateGit(projectId);
  return { status: 'success', message: 'Repository policy saved.' };
}

/** Owner decision 13 — "Run contract and migration checks" on a client environment, as a GitHub workflow. */
export async function dispatchEnvironmentChecksAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const checks = formData.getAll('checks').map(String).filter((c): c is 'api_contract' | 'migrations' => c === 'api_contract' || c === 'migrations');
  const result = await dispatchEnvironmentChecks({
    projectId,
    environmentId: str(formData, 'environmentId'),
    checks,
    workflowFile: str(formData, 'workflowFile').trim() || undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateGit(projectId);
  return { status: 'success', message: `${result.data.workflowFile} dispatched on GitHub Actions. Use Read result once it has run.` };
}

/** Owner decision 13 — the status read: what GitHub says about the dispatched checks, recorded on the environment. */
export async function refreshEnvironmentChecksAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await refreshEnvironmentChecks({ projectId, environmentId: str(formData, 'environmentId') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateGit(projectId);
  const runs = result.data.runs;
  if (runs.length === 0) return { status: 'success', message: 'Nothing is waiting for a result.' };
  const done = runs.filter((r) => r.status === 'completed');
  const waiting = runs.length - done.length;
  return {
    status: 'success',
    message: `${done.length} finished and recorded${done.length > 0 ? ` (${done.map((r) => r.conclusion).join(', ')})` : ''}${waiting > 0 ? `; ${waiting} still waiting for GitHub` : ''}.`,
  };
}
