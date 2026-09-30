import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-017's two reads for "Attach to project memory".
 *
 * **Which projects a meeting can be attached to.** A meeting belongs to a
 * lead; a project belongs to a client account; the lead reaches the account
 * through the opportunities it opened (`sales.opportunities.lead_id` →
 * `client_account_id`). Those accounts' live projects are what is offered —
 * the same trace `listClientLeads` walks the other way.
 *
 * **What has already been attached.** Memory rows whose provenance is one of
 * this meeting's evidence rows, so the page can say "in the memory of
 * project X" rather than offering the same attachment twice.
 */
export type ProjectOption = { id: string; name: string; status: string };

export async function listProjectsForLead(leadId: string): Promise<ProjectOption[]> {
  const supabase = await createClient();

  const { data: opportunities, error: oppError } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('client_account_id')
    .eq('lead_id', leadId);
  if (oppError) unreadable('listProjectsForLead.opportunities', oppError);

  const accountIds = [...new Set((opportunities ?? []).map((o) => o.client_account_id).filter((id): id is string => Boolean(id)))];
  if (accountIds.length === 0) return [];

  const { data: projects, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, status')
    .in('client_account_id', accountIds)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) unreadable('listProjectsForLead.projects', error);

  return (projects ?? []).map((p) => ({ id: p.id, name: p.name, status: p.status }));
}

export type MeetingMemoryAttachment = {
  memoryId: string;
  projectId: string;
  projectName: string | null;
  confidence: string;
  evidenceId: string;
  createdAt: string;
};

export async function listMeetingMemoryAttachments(meetingId: string): Promise<MeetingMemoryAttachment[]> {
  const supabase = await createClient();

  const { data: evidence, error: evidenceError } = await supabase
    .schema('crm')
    .from('meeting_evidence')
    .select('id')
    .eq('meeting_id', meetingId);
  if (evidenceError) unreadable('listMeetingMemoryAttachments.evidence', evidenceError);
  const evidenceIds = (evidence ?? []).map((e) => e.id);
  if (evidenceIds.length === 0) return [];

  const { data: memories, error } = await supabase
    .schema('ai')
    .from('memory_records')
    .select('id, scope, scope_id, confidence, source_id, created_at')
    .eq('source_kind', 'crm.meeting_evidence')
    .in('source_id', evidenceIds)
    .eq('scope', 'project')
    .is('superseded_by', null)
    .order('created_at', { ascending: false });
  if (error) unreadable('listMeetingMemoryAttachments.memories', error);

  const rows = (memories ?? []).filter((m) => m.scope_id !== null && m.source_id !== null);
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((m) => m.scope_id as string))];
  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name')
    .in('id', projectIds);
  if (projectsError) unreadable('listMeetingMemoryAttachments.projects', projectsError);
  const nameOf = new Map((projects ?? []).map((p) => [p.id, p.name]));

  return rows.map((m) => ({
    memoryId: m.id,
    projectId: m.scope_id as string,
    projectName: nameOf.get(m.scope_id as string) ?? null,
    confidence: m.confidence,
    evidenceId: m.source_id as string,
    createdAt: m.created_at,
  }));
}
