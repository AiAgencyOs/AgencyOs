import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { mergeActivity, actionLabel, type ActivityRow } from './project-activity';
import { readChangeRequests } from './queries';

/**
 * The project's activity feed (SCR-027): audit rows about the project and its
 * records through `projects.project_activity` (any internal reader; the
 * snapshots are never returned), plus the events each table timestamps itself.
 * A failed read refuses; an empty feed is an answer.
 */
export async function readProjectActivity(
  projectId: string,
  domain: {
    tasks: readonly { id: string; title: string; completedAt: string | null }[];
    milestones: readonly { id: string; name: string; met_at: string | null }[];
  },
  limit = 200,
): Promise<ActivityRow[]> {
  const supabase = await createClient();
  const [audit, changeRequests, announcements, emails] = await Promise.all([
    supabase.schema('projects').rpc('project_activity', { p_project_id: projectId, p_limit: limit }),
    readChangeRequests(projectId),
    // SCR-059 (theme W5): an announcement is recorded against the project it names, once published.
    supabase.schema('crm').from('announcements').select('id, title, audience, published_at').eq('project_id', projectId).eq('status', 'published').not('published_at', 'is', null).order('published_at', { ascending: false }).limit(50),
    // SCR-057 (theme W5): a client update or email sent about this project — only what the provider accepted.
    supabase.schema('crm').from('outbound_emails').select('id, kind, subject, created_at').eq('project_id', projectId).eq('status', 'sent').order('created_at', { ascending: false }).limit(50),
  ]);
  if (audit.error) unreadable('readProjectActivity.audit', audit.error);
  if (announcements.error) unreadable('readProjectActivity.announcements', announcements.error);
  if (emails.error) unreadable('readProjectActivity.emails', emails.error);

  type AuditRow = { id: number; created_at: string; action: string; actor_type: string; actor_name: string | null; subject_type: string; subject_id: string | null; detail: string | null };
  const rows: ActivityRow[] = ((audit.data ?? []) as AuditRow[]).map((a) => ({
    key: `audit-${a.id}`,
    at: a.created_at,
    source: 'audit' as const,
    action: a.action,
    label: a.detail ?? '',
    actor: a.actor_name ?? (a.actor_type === 'user' ? null : a.actor_type),
    subjectType: a.subject_type,
    subjectId: a.subject_id,
  }));
  for (const t of domain.tasks) {
    if (t.completedAt) rows.push({ key: `task-${t.id}`, at: t.completedAt, source: 'record', action: 'task.completed', label: t.title, actor: null, subjectType: 'task', subjectId: t.id });
  }
  for (const m of domain.milestones) {
    if (m.met_at) rows.push({ key: `ms-${m.id}`, at: m.met_at, source: 'record', action: 'milestone.met', label: m.name, actor: null, subjectType: 'milestone', subjectId: m.id });
  }
  for (const cr of changeRequests) {
    const text = cr.requested.length > 100 ? `${cr.requested.slice(0, 100)}…` : cr.requested;
    rows.push({ key: `cr-${cr.id}`, at: cr.createdAt, source: 'record', action: 'change_request.raised', label: text, actor: null, subjectType: 'change_request', subjectId: cr.id });
    if (cr.decidedAt) rows.push({ key: `crd-${cr.id}`, at: cr.decidedAt, source: 'record', action: `change_request.${cr.status}`, label: text, actor: null, subjectType: 'change_request', subjectId: cr.id });
  }
  for (const a of announcements.data ?? []) {
    rows.push({ key: `ann-${a.id}`, at: a.published_at!, source: 'record', action: 'announcement.published', label: `${a.title}${a.audience === 'clients' ? ' (for clients)' : ''}`, actor: null, subjectType: 'announcement', subjectId: a.id });
  }
  for (const e of emails.data ?? []) {
    rows.push({ key: `mail-${e.id}`, at: e.created_at, source: 'record', action: e.kind === 'client_update' ? 'client_update.sent' : 'email.sent', label: e.subject, actor: null, subjectType: 'outbound_email', subjectId: e.id });
  }
  return mergeActivity(rows);
}

export { actionLabel };
