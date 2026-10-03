import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { assigneeCandidates, type ProjectRole } from './project-members-schema';

/**
 * Project members and presence — SCR-025 (migration 20261001120000).
 *
 * `listProjectMembers` is the chosen roster; `listAssigneeCandidates` is
 * what the Board's assignee pickers offer (members, or the organisation
 * roster when the project has none — the pure rule in the schema file);
 * `readLastActive` is "presence" as the schema can honestly state it: the
 * newest `audit.audit_log` row per person. There is no session table
 * readable from here, so "online now" is not claimed — "last active" is.
 * The audit log is readable by `audit.read` roles only; for anyone else the
 * reader answers `visible: false` rather than "never active".
 */

export type ProjectMember = {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  /** The organisation role the membership carries. */
  orgRole: string;
  projectRole: ProjectRole;
  addedByName: string | null;
  createdAt: string;
};

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_members')
    .select('id, user_id, project_role, added_by, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) unreadable('listProjectMembers', error);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const userIds = [...new Set([...rows.map((r) => r.user_id), ...rows.map((r) => r.added_by).filter((id): id is string => id !== null)])];
  const { data: memberships, error: membershipsError } = await supabase
    .schema('core')
    .from('memberships')
    .select('user_id, role, users:user_id(full_name, email)')
    .in('user_id', userIds);
  if (membershipsError) unreadable('listProjectMembers.memberships', membershipsError);

  const byUser = new Map<string, { fullName: string; email: string; role: string }>();
  for (const m of (memberships ?? []) as Record<string, unknown>[]) {
    const userId = m.user_id as string;
    if (byUser.has(userId)) continue;
    const user = (m.users ?? {}) as { full_name?: string | null; email?: string | null };
    byUser.set(userId, { fullName: user.full_name ?? user.email ?? 'someone without a name on file', email: user.email ?? '', role: m.role as string });
  }

  return rows.map((r) => {
    const u = byUser.get(r.user_id);
    return {
      id: r.id,
      userId: r.user_id,
      fullName: u?.fullName ?? 'Former member',
      email: u?.email ?? '',
      orgRole: u?.role ?? 'member',
      projectRole: r.project_role as ProjectRole,
      addedByName: r.added_by ? (byUser.get(r.added_by)?.fullName ?? null) : null,
      createdAt: r.created_at,
    };
  });
}

export type AssigneeCandidate = { userId: string; fullName: string };

/** The Board's assignee list — the project's members, or the roster when it has none. */
export async function listAssigneeCandidates(projectId: string): Promise<{ people: AssigneeCandidate[]; source: 'members' | 'roster' }> {
  const supabase = await createClient();
  const [members, roster] = await Promise.all([
    listProjectMembers(projectId),
    supabase.schema('core').from('memberships').select('user_id, users:user_id(full_name, email)'),
  ]);
  if (roster.error) unreadable('listAssigneeCandidates.roster', roster.error);

  const seen = new Set<string>();
  const rosterPeople: AssigneeCandidate[] = [];
  for (const m of (roster.data ?? []) as Record<string, unknown>[]) {
    const userId = m.user_id as string;
    if (seen.has(userId)) continue;
    seen.add(userId);
    const user = (m.users ?? {}) as { full_name?: string | null; email?: string | null };
    rosterPeople.push({ userId, fullName: user.full_name ?? user.email ?? 'someone without a name on file' });
  }

  const picked = assigneeCandidates(
    members.map((m) => ({ userId: m.userId, fullName: m.fullName })),
    rosterPeople,
  );
  picked.people.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return picked;
}

export type LastActive =
  | { visible: false; reason: string }
  | { visible: true; byUser: Record<string, string> };

/**
 * "Last active" per person from the audit log — the newest row each
 * actor wrote. Bounded to a recent window (the last `limit` rows) so a
 * long history is not scanned for a page header; a person outside the
 * window simply has no date, which the page says as "not in the last …".
 */
export async function readLastActive(userIds: readonly string[], canReadAudit: boolean, limit = 2000): Promise<LastActive> {
  if (!canReadAudit) return { visible: false, reason: 'Activity dates come from the audit log, which owners and ops admins can read.' };
  if (userIds.length === 0) return { visible: true, byUser: {} };

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('audit')
    .from('audit_log')
    .select('actor_id, created_at')
    .eq('actor_type', 'user')
    .in('actor_id', [...userIds])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('readLastActive', error);

  const byUser: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.actor_id && !(row.actor_id in byUser)) byUser[row.actor_id] = row.created_at;
  }
  return { visible: true, byUser };
}
