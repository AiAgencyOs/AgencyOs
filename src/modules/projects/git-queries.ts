import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-039/041/042/043 — what the panel wrote to GitHub and which commits a
 * person linked to a task. `projects.git_actions` and `projects.commit_links`
 * as stored; every failed read refuses.
 */

export type GitAction = {
  id: string;
  projectId: string;
  taskId: string | null;
  action: string;
  repository: string;
  reference: string;
  url: string | null;
  detail: Record<string, unknown>;
  actorId: string | null;
  createdAt: string;
};

const ACTION_SELECT = 'id, project_id, task_id, action, repository, reference, url, detail, actor_id, created_at';

type ActionRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  action: string;
  repository: string;
  reference: string;
  url: string | null;
  detail: unknown;
  actor_id: string | null;
  created_at: string;
};

const toAction = (r: ActionRow): GitAction => ({
  id: r.id,
  projectId: r.project_id,
  taskId: r.task_id,
  action: r.action,
  repository: r.repository,
  reference: r.reference,
  url: r.url,
  detail: (r.detail ?? {}) as Record<string, unknown>,
  actorId: r.actor_id,
  createdAt: r.created_at,
});

export async function listGitActions(projectId: string, limit = 30): Promise<GitAction[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('git_actions')
    .select(ACTION_SELECT)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listGitActions', error);
  return ((data ?? []) as ActionRow[]).map(toAction);
}

/** Across every project — the Development dashboard's "recent builds" (SCR-039). */
export async function listRecentGitActions(limit = 20): Promise<(GitAction & { projectName: string })[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('git_actions')
    .select(ACTION_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listRecentGitActions', error);
  const rows = ((data ?? []) as ActionRow[]).map(toAction);
  if (rows.length === 0) return [];

  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name')
    .in('id', [...new Set(rows.map((r) => r.projectId))]);
  if (projectsError) unreadable('listRecentGitActions.projects', projectsError);
  const nameOf = new Map((projects ?? []).map((p) => [p.id, p.name]));
  return rows.map((r) => ({ ...r, projectName: nameOf.get(r.projectId) ?? 'a project' }));
}

export type CommitLink = {
  id: string;
  projectId: string;
  taskId: string;
  sha: string;
  shortSha: string;
  url: string | null;
  message: string | null;
  linkedBy: string | null;
  createdAt: string;
};

const COMMIT_SELECT = 'id, project_id, task_id, sha, url, message, linked_by, created_at';

type CommitRow = { id: string; project_id: string; task_id: string; sha: string; url: string | null; message: string | null; linked_by: string | null; created_at: string };

const toCommit = (c: CommitRow): CommitLink => ({
  id: c.id,
  projectId: c.project_id,
  taskId: c.task_id,
  sha: c.sha,
  shortSha: c.sha.slice(0, 7),
  url: c.url,
  message: c.message,
  linkedBy: c.linked_by,
  createdAt: c.created_at,
});

export async function listCommitLinksForTask(taskId: string): Promise<CommitLink[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('commit_links')
    .select(COMMIT_SELECT)
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) unreadable('listCommitLinksForTask', error);
  return ((data ?? []) as CommitRow[]).map(toCommit);
}

export async function listCommitLinks(projectId: string, limit = 50): Promise<(CommitLink & { taskTitle: string })[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('commit_links')
    .select(COMMIT_SELECT)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listCommitLinks', error);
  const rows = ((data ?? []) as CommitRow[]).map(toCommit);
  if (rows.length === 0) return [];
  const { data: tasks, error: tasksError } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, title')
    .in('id', [...new Set(rows.map((r) => r.taskId))]);
  if (tasksError) unreadable('listCommitLinks.tasks', tasksError);
  const titleOf = new Map((tasks ?? []).map((t) => [t.id, t.title]));
  return rows.map((r) => ({ ...r, taskTitle: titleOf.get(r.taskId) ?? 'a task' }));
}

/** Across every project — the Development dashboard's "recent commits" (SCR-039). */
export async function listRecentCommitLinks(limit = 20): Promise<(CommitLink & { taskTitle: string; projectName: string })[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('commit_links')
    .select(COMMIT_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listRecentCommitLinks', error);
  const rows = ((data ?? []) as CommitRow[]).map(toCommit);
  if (rows.length === 0) return [];
  const [tasks, projects] = await Promise.all([
    supabase.schema('projects').from('tasks').select('id, title').in('id', [...new Set(rows.map((r) => r.taskId))]),
    supabase.schema('projects').from('projects').select('id, name').in('id', [...new Set(rows.map((r) => r.projectId))]),
  ]);
  if (tasks.error) unreadable('listRecentCommitLinks.tasks', tasks.error);
  if (projects.error) unreadable('listRecentCommitLinks.projects', projects.error);
  const titleOf = new Map((tasks.data ?? []).map((t) => [t.id, t.title]));
  const nameOf = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  return rows.map((r) => ({ ...r, taskTitle: titleOf.get(r.taskId) ?? 'a task', projectName: nameOf.get(r.projectId) ?? 'a project' }));
}

/** The tasks a commit may be linked to on the Repository tab: every task of the project, newest first. */
export async function listTaskOptions(projectId: string): Promise<{ id: string; title: string; status: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, title, status')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) unreadable('listTaskOptions', error);
  return (data ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status }));
}
