import 'server-only';

import { createClient } from '@/lib/db/server';
import { ilikeAny } from '@/lib/db/search';
import { unreadable } from '@/lib/result';

import type { AnnouncementAudience, AnnouncementStatus } from './announcements-schema';

export type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  status: AnnouncementStatus;
  publishedAt: string | null;
  archivedAt: string | null;
  /** SCR-059 (bucket F): the moment the tick publishes a draft, or null. */
  scheduledFor: string | null;
  createdAt: string;
  /** SCR-059: what the announcement is recorded against — a project (and through it a client), or one client, or neither (agency-wide). */
  projectId: string | null;
  projectName: string | null;
  clientAccountId: string | null;
  clientName: string | null;
  /** 'milestone' when a met milestone drafted it from the milestone template. */
  source: 'manual' | 'milestone';
  /** The milestone whose being met drafted it. */
  milestoneId: string | null;
};

/** Announcements, newest first; filterable by audience and status. RLS scopes to the organization. */
export async function listAnnouncements(filter: { audience?: AnnouncementAudience; status?: AnnouncementStatus; limit?: number; projectId?: string; clientAccountId?: string; agencyWideToo?: boolean; q?: string } = {}): Promise<AnnouncementRow[]> {
  const supabase = await createClient();
  let query = supabase
    .schema('crm')
    .from('announcements')
    .select('id, title, body, audience, status, published_at, archived_at, scheduled_for, created_at, project_id, client_account_id, source, milestone_id')
    .order('created_at', { ascending: false })
    .limit(filter.limit ?? 100);
  if (filter.audience) query = query.eq('audience', filter.audience);
  if (filter.status) query = query.eq('status', filter.status);
  // SCR-059: search by words in the title or body, server-side, so it reaches past the newest page.
  if (filter.q) query = query.or(ilikeAny(['title', 'body'], filter.q));
  // A project's timeline shows what names it; a client's shows what names it, what names one of its projects
  // (the door copies the project's client onto the row), and — unless told otherwise — the agency-wide ones.
  if (filter.projectId) query = query.eq('project_id', filter.projectId);
  if (filter.clientAccountId) {
    query = filter.agencyWideToo === false
      ? query.eq('client_account_id', filter.clientAccountId)
      : query.or(`client_account_id.eq.${filter.clientAccountId},and(client_account_id.is.null,project_id.is.null)`);
  }
  const { data, error } = await query;
  if (error) unreadable('listAnnouncements', error);

  const projectIds = [...new Set((data ?? []).map((a) => a.project_id).filter((id): id is string => Boolean(id)))];
  const clientIds = [...new Set((data ?? []).map((a) => a.client_account_id).filter((id): id is string => Boolean(id)))];
  const [projects, clients] = await Promise.all([
    projectIds.length > 0 ? supabase.schema('projects').from('projects').select('id, name').in('id', projectIds) : Promise.resolve({ data: [], error: null }),
    clientIds.length > 0 ? supabase.schema('core').from('client_accounts').select('id, name').in('id', clientIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (projects.error) unreadable('listAnnouncements.projects', projects.error);
  if (clients.error) unreadable('listAnnouncements.clients', clients.error);
  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const clientName = new Map((clients.data ?? []).map((c) => [c.id, c.name]));

  return (data ?? []).map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    audience: a.audience as AnnouncementAudience,
    status: a.status as AnnouncementStatus,
    publishedAt: a.published_at,
    archivedAt: a.archived_at,
    scheduledFor: a.scheduled_for,
    createdAt: a.created_at,
    projectId: a.project_id,
    projectName: a.project_id ? (projectName.get(a.project_id) ?? null) : null,
    clientAccountId: a.client_account_id,
    clientName: a.client_account_id ? (clientName.get(a.client_account_id) ?? null) : null,
    source: a.source === 'milestone' ? 'milestone' : 'manual',
    milestoneId: a.milestone_id,
  }));
}

/** SCR-059: the pickers the announcement composer needs — projects (with the client each belongs to) and clients. */
export type AnnouncementTargets = {
  projects: { id: string; name: string; clientAccountId: string }[];
  clients: { id: string; name: string; billingEmail: string | null }[];
};

export async function listAnnouncementTargets(): Promise<AnnouncementTargets> {
  const supabase = await createClient();
  const [projects, clients] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name, client_account_id').is('deleted_at', null).order('created_at', { ascending: false }).limit(300),
    supabase.schema('core').from('client_accounts').select('id, name, billing_email').order('name', { ascending: true }).limit(300),
  ]);
  if (projects.error) unreadable('listAnnouncementTargets.projects', projects.error);
  if (clients.error) unreadable('listAnnouncementTargets.clients', clients.error);
  return {
    projects: (projects.data ?? []).map((p) => ({ id: p.id, name: p.name, clientAccountId: p.client_account_id })),
    clients: (clients.data ?? []).map((c) => ({ id: c.id, name: c.name, billingEmail: c.billing_email })),
  };
}
