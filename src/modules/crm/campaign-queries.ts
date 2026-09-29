import 'server-only';

import { ilikeAny } from '@/lib/db/search';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { campaignAudienceSchema, type AudienceCandidate, type CampaignAudience } from './campaign-schema';
import type { CampaignRecipientStatus, CampaignStatus } from './campaign-types';

/**
 * Readers for SCR-059's campaigns — owner decision 2026-09-30. RLS scopes
 * every row to the session's organization; a failed read refuses rather
 * than showing an empty campaign list as "nothing planned".
 */

export type CampaignListRow = {
  id: string;
  name: string;
  status: CampaignStatus;
  templateId: string;
  templateName: string | null;
  languageCode: string | null;
  audience: CampaignAudience;
  recipients: number;
  sent: number;
  refused: number;
  failed: number;
  scheduledFor: string | null;
  createdBy: string | null;
  createdByEmail: string | null;
  approvedBy: string | null;
  approvedByEmail: string | null;
  approvedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelledReason: string | null;
  createdAt: string;
  updatedAt: string;
};

const CAMPAIGN_SELECT =
  'id, name, status, template_id, audience, scheduled_for, recipients_count, sent_count, refused_count, failed_count, created_by, approved_by, approved_at, started_at, finished_at, cancelled_reason, created_at, updated_at, whatsapp_templates(template_name, language_code)';

type CampaignRaw = {
  id: string;
  name: string;
  status: string;
  template_id: string;
  audience: unknown;
  scheduled_for: string | null;
  recipients_count: number;
  sent_count: number;
  refused_count: number;
  failed_count: number;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
  updated_at: string;
  whatsapp_templates: { template_name: string; language_code: string } | null;
};

function asStatus(value: string): CampaignStatus {
  return value === 'approved' || value === 'running' || value === 'done' || value === 'cancelled' ? value : 'draft';
}

async function withEmails(rows: CampaignRaw[]): Promise<CampaignListRow[]> {
  const supabase = await createClient();
  const userIds = [...new Set(rows.flatMap((r) => [r.created_by, r.approved_by]).filter((id): id is string => id !== null))];
  const { data: users, error } =
    userIds.length > 0
      ? await supabase.schema('core').from('users').select('id, email').in('id', userIds)
      : { data: [] as { id: string; email: string }[], error: null };
  if (error) unreadable('listCampaigns.users', error);
  const emailById = new Map((users ?? []).map((u) => [u.id, u.email]));

  return rows.map((r) => {
    const audience = campaignAudienceSchema.safeParse(r.audience ?? {});
    return {
      id: r.id,
      name: r.name,
      status: asStatus(r.status),
      templateId: r.template_id,
      templateName: r.whatsapp_templates?.template_name ?? null,
      languageCode: r.whatsapp_templates?.language_code ?? null,
      audience: audience.success ? audience.data : {},
      recipients: r.recipients_count,
      sent: r.sent_count,
      refused: r.refused_count,
      failed: r.failed_count,
      scheduledFor: r.scheduled_for,
      createdBy: r.created_by,
      createdByEmail: r.created_by ? (emailById.get(r.created_by) ?? null) : null,
      approvedBy: r.approved_by,
      approvedByEmail: r.approved_by ? (emailById.get(r.approved_by) ?? null) : null,
      approvedAt: r.approved_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      cancelledReason: r.cancelled_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export async function listCampaigns(limit = 200, q?: string): Promise<CampaignListRow[]> {
  const supabase = await createClient();
  let query = supabase
    .schema('crm')
    .from('campaigns')
    .select(CAMPAIGN_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);
  // Search within domain (bucket G-3): the campaign's name, server-side.
  if (q) query = query.or(ilikeAny(['name'], q));
  const { data, error } = await query;
  if (error) unreadable('listCampaigns', error);
  return withEmails((data ?? []) as CampaignRaw[]);
}

export async function getCampaign(campaignId: string): Promise<CampaignListRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('campaigns')
    .select(CAMPAIGN_SELECT)
    .eq('id', campaignId)
    .maybeSingle();
  if (error) unreadable('getCampaign', error);
  if (!data) return null;
  const [row] = await withEmails([data as CampaignRaw]);
  return row ?? null;
}

export type CampaignRecipientRow = {
  id: string;
  leadId: string | null;
  leadTitle: string | null;
  conversationId: string | null;
  status: CampaignRecipientStatus;
  reason: string | null;
  messageId: string | null;
  decidedAt: string | null;
  createdAt: string;
};

/** Every recipient of a campaign, with the lead's title for the table; decided rows first, newest decision first. */
export async function listCampaignRecipients(campaignId: string, limit = 2000): Promise<CampaignRecipientRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('campaign_recipients')
    .select('id, lead_id, conversation_id, status, reason, message_id, decided_at, created_at, leads(title)')
    .eq('campaign_id', campaignId)
    .order('decided_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) unreadable('listCampaignRecipients', error);

  return (data ?? []).map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    leadTitle: (r.leads as { title: string } | null)?.title ?? null,
    conversationId: r.conversation_id,
    status: r.status === 'sent' || r.status === 'refused' || r.status === 'failed' ? r.status : 'pending',
    reason: r.reason,
    messageId: r.message_id,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  }));
}

/**
 * Every live lead of the organization as the audience expansion sees it,
 * with its own WhatsApp thread when it has one (the newest, as the Lead 360
 * page picks it). Read once, filtered by `expandAudience` — the same rows the
 * preview counted are the rows approval writes.
 */
export async function readAudienceCandidates(limit = 5000): Promise<AudienceCandidate[]> {
  const supabase = await createClient();
  const { data: leads, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, status, source, assigned_to, service, tags, created_at, updated_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) unreadable('readAudienceCandidates', error);

  const rows = leads ?? [];
  if (rows.length === 0) return [];

  const { data: conversations, error: convError } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, lead_id, created_at')
    .in('lead_id', rows.map((l) => l.id))
    .order('created_at', { ascending: false })
    .limit(limit);
  if (convError) unreadable('readAudienceCandidates.conversations', convError);

  // Newest thread per lead wins, matching `getLatestConversation`.
  const threadByLead = new Map<string, string>();
  for (const c of conversations ?? []) {
    if (c.lead_id && !threadByLead.has(c.lead_id)) threadByLead.set(c.lead_id, c.id);
  }

  // SCR-059 (bucket F): the projects behind each lead, through the
  // opportunity a project was won from — the "project audience" filter.
  const { data: opportunities, error: oppError } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id, lead_id')
    .in('lead_id', rows.map((l) => l.id))
    .limit(limit);
  if (oppError) unreadable('readAudienceCandidates.opportunities', oppError);
  const leadByOpportunity = new Map((opportunities ?? []).filter((o) => o.lead_id).map((o) => [o.id, o.lead_id as string]));
  const projectsByLead = new Map<string, string[]>();
  if (leadByOpportunity.size > 0) {
    const { data: projects, error: projError } = await supabase
      .schema('projects')
      .from('projects')
      .select('id, opportunity_id')
      .in('opportunity_id', [...leadByOpportunity.keys()])
      .is('deleted_at', null)
      .limit(limit);
    if (projError) unreadable('readAudienceCandidates.projects', projError);
    for (const p of projects ?? []) {
      const leadId = p.opportunity_id ? leadByOpportunity.get(p.opportunity_id) : undefined;
      if (!leadId) continue;
      projectsByLead.set(leadId, [...(projectsByLead.get(leadId) ?? []), p.id]);
    }
  }

  return rows.map((l) => ({
    leadId: l.id,
    status: l.status,
    source: l.source,
    assignedTo: l.assigned_to,
    service: l.service,
    tags: l.tags ?? [],
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    conversationId: threadByLead.get(l.id) ?? null,
    projectIds: projectsByLead.get(l.id) ?? [],
  }));
}

export type CampaignTemplateOption = {
  id: string;
  label: string;
  situationKey: string;
  parameters: string[];
};

/** The templates a campaign may carry: Meta-approved and active, whatever their situation. The door checks again. */
export async function listCampaignTemplates(): Promise<CampaignTemplateOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('whatsapp_templates')
    .select('id, situation_key, template_name, language_code, parameters')
    .eq('status', 'approved')
    .eq('active', true)
    .order('situation_key', { ascending: true })
    .order('template_name', { ascending: true })
    .limit(200);
  if (error) unreadable('listCampaignTemplates', error);
  return (data ?? []).map((t) => ({
    id: t.id,
    label: `${t.template_name} · ${t.language_code}`,
    situationKey: t.situation_key,
    parameters: t.parameters ?? [],
  }));
}

/** The values the audience form offers: sources, owners and services in use. */
export async function readAudienceFacets(): Promise<{ sources: string[]; owners: { id: string; email: string }[]; services: string[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('source, assigned_to, service')
    .is('deleted_at', null)
    .limit(5000);
  if (error) unreadable('readAudienceFacets', error);

  const rows = data ?? [];
  const ownerIds = [...new Set(rows.map((r) => r.assigned_to).filter((id): id is string => id !== null))];
  const { data: users, error: userError } =
    ownerIds.length > 0
      ? await supabase.schema('core').from('users').select('id, email').in('id', ownerIds)
      : { data: [] as { id: string; email: string }[], error: null };
  if (userError) unreadable('readAudienceFacets.users', userError);

  return {
    sources: [...new Set(rows.map((r) => r.source))].sort(),
    owners: (users ?? []).map((u) => ({ id: u.id, email: u.email })).sort((a, b) => a.email.localeCompare(b.email)),
    services: [...new Set(rows.map((r) => r.service).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b)),
  };
}
