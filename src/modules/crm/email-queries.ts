import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type OutboundEmailRow = {
  id: string;
  kind: 'email' | 'client_update';
  to: string;
  subject: string;
  body: string;
  status: 'sent' | 'failed';
  transport: 'resend' | 'smtp' | null;
  error: string | null;
  projectId: string | null;
  projectName: string | null;
  retryOf: string | null;
  retryReason: string | null;
  /** How many times this (failed) send has been sent again. */
  resends: number;
  createdAt: string;
};

/** The email and client-update lane, newest first — SCR-057. RLS scopes to the organization. */
export async function listOutboundEmails(limit = 30): Promise<OutboundEmailRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('outbound_emails')
    .select('id, kind, to_address, subject, body, status, transport, error, project_id, retry_of, retry_reason, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listOutboundEmails', error);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((id): id is string => Boolean(id)))];
  const { data: projects, error: projectsError } = projectIds.length > 0 ? await supabase.schema('projects').from('projects').select('id, name').in('id', projectIds) : { data: [], error: null };
  if (projectsError) unreadable('listOutboundEmails.projects', projectsError);
  const name = new Map((projects ?? []).map((p) => [p.id, p.name]));
  const resends = new Map<string, number>();
  for (const r of rows) if (r.retry_of) resends.set(r.retry_of, (resends.get(r.retry_of) ?? 0) + 1);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === 'client_update' ? 'client_update' : 'email',
    to: r.to_address,
    subject: r.subject,
    body: r.body,
    status: r.status === 'failed' ? 'failed' : 'sent',
    transport: r.transport === 'resend' || r.transport === 'smtp' ? r.transport : null,
    error: r.error,
    projectId: r.project_id,
    projectName: r.project_id ? (name.get(r.project_id) ?? null) : null,
    retryOf: r.retry_of,
    retryReason: r.retry_reason,
    resends: resends.get(r.id) ?? 0,
    createdAt: r.created_at,
  }));
}
