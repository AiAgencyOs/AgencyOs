import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import {
  createTaskBranch as githubCreateTaskBranch,
  describeGithubWriteReason,
  dispatchWorkflow,
  mergePullRequest as githubMergePullRequest,
  submitReview as githubSubmitReview,
  type GithubWriteReason,
} from '@/lib/git/github-write';
import { err, ok, type Result } from '@/lib/result';

import {
  createTaskBranchSchema,
  linkCommitSchema,
  mergePullRequestSchema,
  setRepositoryWorkflowSchema,
  submitReviewSchema,
  triggerBuildSchema,
  type CreateTaskBranchInput,
  type LinkCommitInput,
  type MergePullRequestInput,
  type SetRepositoryWorkflowInput,
  type SubmitReviewInput,
  type TriggerBuildInput,
} from './git-write-schema';
import { getRepositoryLink } from './repository-link-queries';

/**
 * The governed doors to GitHub — Decision: reversed by the owner on
 * 2026-09-30 (bucket F, F4).
 *
 * Order in every door: capability (`task.write` for a branch, `project.write`
 * for a review, a merge and a build — the roles `projects.record_git_action`
 * names again), then the GitHub call through src/lib/git/github-write.ts,
 * and only when GitHub accepted it the `projects.git_actions` row with its
 * audit entry (git.branch_created | git.review_submitted | git.merged |
 * git.build_triggered). A refusal from GitHub — no token, missing scope, a
 * red check — comes back in the fetcher's own words and records nothing,
 * because nothing happened.
 */

function githubRefused(reason: GithubWriteReason, detail: string): Result<never> {
  const code = reason === 'not_configured' || reason === 'missing_scope' ? 'CONFLICT' : reason === 'unauthorized' ? 'FORBIDDEN' : 'PROVIDER_ERROR';
  return err(code, `GitHub: ${describeGithubWriteReason(reason)}. (${detail})`);
}

async function recordGitAction(input: {
  projectId: string;
  taskId?: string;
  action: 'branch_created' | 'review_submitted' | 'merged' | 'build_triggered';
  repository: string;
  reference: string;
  url: string | null;
  detail: Record<string, unknown>;
}): Promise<Result<{ id: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_git_action', {
    p_project_id: input.projectId,
    p_action: input.action,
    p_repository: input.repository,
    p_reference: input.reference,
    p_url: input.url ?? undefined,
    p_detail: input.detail,
    p_task_id: input.taskId,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordGitAction', detail: error.message }));
    return err('INTERNAL', `GitHub accepted the ${input.action.replace('_', ' ')}, but the panel could not record it. Check the repository directly.`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null } | undefined;
  if (row?.outcome === 'recorded' && row.id) return ok({ id: row.id });
  return err(
    row?.outcome === 'forbidden' ? 'FORBIDDEN' : 'INTERNAL',
    `GitHub accepted the ${input.action.replace('_', ' ')}, but the database refused to record it (${row?.outcome ?? 'no answer'}).`,
  );
}

async function linkedRepository(projectId: string) {
  const link = await getRepositoryLink(projectId);
  if (!link) return null;
  return { owner: link.owner, repo: link.repo, defaultBranch: link.defaultBranch, workflowFile: link.workflowFile, full: `${link.owner}/${link.repo}` };
}

export async function createTaskBranch(input: CreateTaskBranchInput): Promise<Result<{ branch: string; url: string }>> {
  const parsed = createTaskBranchSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid task.');

  const context = await requireInternal();
  if (!can(context.role, 'task.write')) return err('FORBIDDEN', 'You do not have permission to create a task branch.');

  const supabase = await createClient();
  const { data: task, error: taskError } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, project_id, title')
    .eq('id', parsed.data.taskId)
    .maybeSingle();
  if (taskError) {
    console.error(JSON.stringify({ level: 'error', scope: 'createTaskBranch.task', detail: taskError.message }));
    return err('INTERNAL', 'Could not read the task.');
  }
  if (!task || task.project_id !== parsed.data.projectId) return err('NOT_FOUND', 'Task not found on this project.');

  const link = await linkedRepository(parsed.data.projectId);
  if (!link) return err('CONFLICT', 'This project has no linked GitHub repository. Link one on the Repository tab first.');

  const created = await githubCreateTaskBranch({ link, taskId: task.id, title: task.title });
  if (!created.ok) return githubRefused(created.reason, created.detail);

  const recorded = await recordGitAction({
    projectId: parsed.data.projectId,
    taskId: task.id,
    action: 'branch_created',
    repository: link.full,
    reference: created.data.branch,
    url: created.data.url,
    detail: { fromBranch: created.data.fromBranch, sha: created.data.sha },
  });
  if (!recorded.ok) return recorded;
  return ok({ branch: created.data.branch, url: created.data.url });
}

export async function submitReview(input: SubmitReviewInput): Promise<Result<{ state: string; url: string }>> {
  const parsed = submitReviewSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid review.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to submit a review.');

  const link = await linkedRepository(parsed.data.projectId);
  if (!link) return err('CONFLICT', 'This project has no linked GitHub repository.');

  const sent = await githubSubmitReview({ link, pullNumber: parsed.data.pullNumber, event: parsed.data.event, body: parsed.data.body });
  if (!sent.ok) return githubRefused(sent.reason, sent.detail);

  const recorded = await recordGitAction({
    projectId: parsed.data.projectId,
    action: 'review_submitted',
    repository: link.full,
    reference: `#${parsed.data.pullNumber}`,
    url: sent.data.url,
    detail: { event: parsed.data.event, state: sent.data.state, reviewId: sent.data.reviewId, body: parsed.data.body },
  });
  if (!recorded.ok) return recorded;
  return ok({ state: sent.data.state, url: sent.data.url });
}

export async function mergePullRequest(input: MergePullRequestInput): Promise<Result<{ sha: string; url: string }>> {
  const parsed = mergePullRequestSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid pull request.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to merge a pull request.');

  const link = await linkedRepository(parsed.data.projectId);
  if (!link) return err('CONFLICT', 'This project has no linked GitHub repository.');

  const merged = await githubMergePullRequest({ link, pullNumber: parsed.data.pullNumber });
  if (!merged.ok) return githubRefused(merged.reason, merged.detail);

  const recorded = await recordGitAction({
    projectId: parsed.data.projectId,
    action: 'merged',
    repository: link.full,
    reference: `#${parsed.data.pullNumber}`,
    url: merged.data.url,
    detail: { method: 'squash', sha: merged.data.sha, headSha: merged.data.headSha, title: merged.data.title },
  });
  if (!recorded.ok) return recorded;
  return ok({ sha: merged.data.sha, url: merged.data.url });
}

export async function linkCommit(input: LinkCommitInput): Promise<Result<{ linkId: string; existed: boolean }>> {
  const parsed = linkCommitSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid commit.');

  const context = await requireInternal();
  if (!can(context.role, 'task.write')) return err('FORBIDDEN', 'You do not have permission to link a commit.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('link_commit', {
    p_task_id: parsed.data.taskId,
    p_sha: parsed.data.sha,
    p_url: parsed.data.url || undefined,
    p_message: parsed.data.message || undefined,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'linkCommit', detail: error.message }));
    return err('INTERNAL', 'Could not link the commit.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; link_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'linked':
      return ok({ linkId: row.link_id ?? '', existed: false });
    case 'already_linked':
      return ok({ linkId: row.link_id ?? '', existed: true });
    case 'not_found':
      return err('NOT_FOUND', 'Task not found.');
    case 'bad_sha':
      return err('VALIDATION', 'A commit sha is 7 to 40 hex characters.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not link a commit.');
    default:
      return err('INTERNAL', 'Could not link the commit.');
  }
}

/**
 * SCR-043 "Trigger build": a `git_actions` row (build_triggered, audited)
 * always; a GitHub Actions `workflow_dispatch` on the default branch when
 * the link names a workflow file — and when that dispatch is refused, the
 * refusal is the answer and nothing is recorded, because no build was
 * triggered.
 */
export async function triggerBuild(input: TriggerBuildInput): Promise<Result<{ dispatched: boolean; workflowFile: string | null; url: string | null }>> {
  const parsed = triggerBuildSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid project.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to trigger a build.');

  const link = await linkedRepository(parsed.data.projectId);
  if (!link) return err('CONFLICT', 'This project has no linked GitHub repository. Link one on the Repository tab first.');

  let url: string | null = null;
  if (link.workflowFile) {
    const dispatched = await dispatchWorkflow({ link, workflowFile: link.workflowFile, ref: link.defaultBranch });
    if (!dispatched.ok) return githubRefused(dispatched.reason, dispatched.detail);
    url = dispatched.data.url;
  }

  const recorded = await recordGitAction({
    projectId: parsed.data.projectId,
    action: 'build_triggered',
    repository: link.full,
    reference: link.workflowFile ?? 'record only',
    url,
    detail: { dispatched: Boolean(link.workflowFile), ref: link.defaultBranch, note: parsed.data.note ?? null },
  });
  if (!recorded.ok) return recorded;
  return ok({ dispatched: Boolean(link.workflowFile), workflowFile: link.workflowFile, url });
}

export async function setRepositoryWorkflow(input: SetRepositoryWorkflowInput): Promise<Result<{ workflowFile: string | null }>> {
  const parsed = setRepositoryWorkflowSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid workflow file.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change the repository link.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_repository_workflow', {
    p_project_id: parsed.data.projectId,
    p_workflow_file: parsed.data.workflowFile,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setRepositoryWorkflow', detail: error.message }));
    return err('INTERNAL', 'Could not set the workflow file.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ workflowFile: parsed.data.workflowFile || null });
    case 'unchanged':
      return err('CONFLICT', 'That is already the workflow file.');
    case 'not_linked':
      return err('NOT_FOUND', 'This project has no linked repository.');
    case 'bad_file':
      return err('VALIDATION', 'A workflow file is its name under .github/workflows/, ending in .yml');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may change the link.');
    default:
      return err('INTERNAL', 'Could not set the workflow file.');
  }
}
