import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { groupQaTeam, type QaTeamMember } from './qa-team';
import type { DeviceRun } from './device-tiles';

/** The people whose project role is `qa` — on one project, or across every project. */
export async function readQaTeam(projectId?: string): Promise<QaTeamMember[]> {
  const supabase = await createClient();
  let query = supabase.schema('projects').from('project_members').select('user_id, project_id').eq('project_role', 'qa');
  if (projectId) query = query.eq('project_id', projectId);
  const { data, error } = await query.limit(500);
  if (error) unreadable('readQaTeam', error);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  const [people, projects] = await Promise.all([
    supabase.schema('core').from('memberships').select('user_id, users:user_id(full_name, email)').in('user_id', userIds),
    supabase.schema('projects').from('projects').select('id, name').in('id', projectIds),
  ]);
  if (people.error) unreadable('readQaTeam.people', people.error);
  if (projects.error) unreadable('readQaTeam.projects', projects.error);

  const nameOf = new Map<string, string>();
  for (const m of (people.data ?? []) as Record<string, unknown>[]) {
    const u = (m.users ?? {}) as { full_name?: string | null; email?: string | null };
    nameOf.set(m.user_id as string, u.full_name ?? u.email ?? 'someone without a name on file');
  }
  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  return groupQaTeam(
    rows.map((r) => ({ userId: r.user_id, fullName: nameOf.get(r.user_id) ?? 'Former member', projectId: r.project_id, projectName: projectName.get(r.project_id) ?? 'Unknown project' })),
  );
}

/** Every run in the last 90 days that recorded a device, newest first — the Device Testing tiles' only source. */
export async function listDeviceRuns(projectId?: string, days = 90): Promise<DeviceRun[]> {
  const supabase = await createClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let query = supabase
    .schema('qa')
    .from('test_runs')
    .select('device, os, browser, evidence_url, failed, blocked, status, executed_at')
    .not('device', 'is', null)
    .gte('executed_at', since)
    .order('executed_at', { ascending: false })
    .limit(500);
  if (projectId) query = query.eq('project_id', projectId);
  const { data, error } = await query;
  if (error) unreadable('listDeviceRuns', error);
  return (data ?? []).map((r) => ({
    device: r.device,
    os: r.os,
    browser: r.browser,
    evidenceUrl: r.evidence_url,
    failed: r.failed,
    blocked: r.blocked,
    status: r.status === 'open' ? 'open' : 'closed',
    executedAt: r.executed_at,
  }));
}
