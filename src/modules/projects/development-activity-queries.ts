import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-039 — the two lists the Development dashboard lacked: the developer
 * tasks that are active right now (in progress, in review or blocked) with
 * who holds them, and the newest builds across projects with the commit and
 * build number recorded against each. Both are reads under RLS; a failed
 * read refuses rather than reporting "nothing is active".
 */

export type ActiveDeveloperTask = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: string;
  assigneeName: string | null;
  startedAt: string | null;
};

export async function listActiveDeveloperTasks(limit = 12): Promise<ActiveDeveloperTask[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('tasks')
    .select('id, project_id, title, status, priority, assignee_id, started_at, updated_at')
    .in('status', ['in_progress', 'in_review', 'blocked'])
    .is('archived_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listActiveDeveloperTasks', error);
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  const userIds = [...new Set(rows.map((r) => r.assignee_id).filter((id): id is string => id !== null))];
  const [projects, users] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name').in('id', projectIds),
    userIds.length > 0 ? supabase.schema('core').from('users').select('id, full_name, email').in('id', userIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (projects.error) unreadable('listActiveDeveloperTasks.projects', projects.error);
  if (users.error) unreadable('listActiveDeveloperTasks.users', users.error);
  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const userName = new Map((users.data ?? []).map((u) => [u.id, u.full_name || u.email]));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectName: projectName.get(r.project_id) ?? 'Project',
    title: r.title,
    status: r.status,
    priority: r.priority,
    assigneeName: r.assignee_id ? (userName.get(r.assignee_id) ?? 'Former member') : null,
    startedAt: r.started_at,
  }));
}

export type RecentBuild = {
  id: string;
  projectId: string;
  projectName: string;
  version: number;
  title: string;
  status: string;
  commitRef: string | null;
  buildNumber: string | null;
  createdAt: string;
};

export async function listRecentBuilds(limit = 8): Promise<RecentBuild[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('deliverables')
    .select('id, project_id, version, title, status, created_at')
    .eq('kind', 'build')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listRecentBuilds', error);
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  const [projects, details] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name').in('id', projectIds),
    supabase.schema('projects').from('deliverable_details').select('deliverable_id, commit_ref, build_number').in('deliverable_id', rows.map((r) => r.id)),
  ]);
  if (projects.error) unreadable('listRecentBuilds.projects', projects.error);
  if (details.error) unreadable('listRecentBuilds.details', details.error);
  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const detailOf = new Map((details.data ?? []).map((d) => [d.deliverable_id, d]));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectName: projectName.get(r.project_id) ?? 'Project',
    version: r.version,
    title: r.title,
    status: r.status,
    commitRef: detailOf.get(r.id)?.commit_ref ?? null,
    buildNumber: detailOf.get(r.id)?.build_number ?? null,
    createdAt: r.created_at,
  }));
}
