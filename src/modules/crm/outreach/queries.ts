import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/** Reads for the email-outreach screens. Every failed read refuses (G-054): an empty list is never a hidden error. */

export type OutreachSettingsRow = {
  senderName: string | null;
  postalAddress: string | null;
  replyTo: string | null;
  coldBasisEnabled: boolean;
  dailyCap: number;
  bouncePausePercent: number;
  firstSendOn: string | null;
};

export async function readOutreachSettings(): Promise<OutreachSettingsRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('outreach_settings').select('sender_name, postal_address, reply_to, cold_basis_enabled, daily_cap, bounce_pause_percent, first_send_on').maybeSingle();
  if (error) unreadable('readOutreachSettings', error);
  if (!data) return null;
  return {
    senderName: data.sender_name, postalAddress: data.postal_address, replyTo: data.reply_to,
    coldBasisEnabled: data.cold_basis_enabled, dailyCap: data.daily_cap, bouncePausePercent: Number(data.bounce_pause_percent), firstSendOn: data.first_send_on,
  };
}

export type ProspectRowView = { id: string; email: string; fullName: string | null; company: string | null; language: string; basis: string; status: string; provenance: string; tags: string[]; leadId: string | null };

export async function listProspects(limit = 60): Promise<{ rows: ProspectRowView[]; counts: Record<string, number> }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('outreach_prospects').select('id, email, full_name, company, language, lawful_basis, status, provenance, tags, lead_id').order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('listProspects', error);
  const { data: all, error: countError } = await supabase.schema('crm').from('outreach_prospects').select('status');
  if (countError) unreadable('listProspects.counts', countError);
  const counts: Record<string, number> = {};
  for (const r of all ?? []) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    rows: (data ?? []).map((p) => ({ id: p.id, email: p.email, fullName: p.full_name, company: p.company, language: p.language, basis: p.lawful_basis, status: p.status, provenance: p.provenance, tags: p.tags ?? [], leadId: p.lead_id })),
    counts,
  };
}

export type TemplateView = { id: string; name: string; language: string; subject: string; body: string; status: string; createdBy: string | null };

export async function listEmailTemplates(): Promise<TemplateView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('email_templates').select('id, name, language, subject, body, status, created_by').order('created_at', { ascending: false });
  if (error) unreadable('listEmailTemplates', error);
  return (data ?? []).map((t) => ({ id: t.id, name: t.name, language: t.language, subject: t.subject, body: t.body, status: t.status, createdBy: t.created_by }));
}

export type CampaignView = { id: string; name: string; status: string; recipientCount: number | null; pausedReason: string | null; createdBy: string; approvedBy: string | null; createdAt: string; audience: Record<string, unknown> };

export async function listEmailCampaigns(): Promise<CampaignView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('email_campaigns').select('id, name, status, recipient_count, paused_reason, created_by, approved_by, created_at, audience').order('created_at', { ascending: false });
  if (error) unreadable('listEmailCampaigns', error);
  return (data ?? []).map((c) => ({ id: c.id, name: c.name, status: c.status, recipientCount: c.recipient_count, pausedReason: c.paused_reason, createdBy: c.created_by, approvedBy: c.approved_by, createdAt: c.created_at, audience: (c.audience ?? {}) as Record<string, unknown> }));
}

export type CampaignDetail = {
  campaign: CampaignView;
  steps: { stepNumber: number; templateName: string; delayDays: number }[];
  byStatus: Record<string, number>;
  sends: { sent: number; bounced: number; failed: number; reserved: number };
  recent: { email: string; stepNumber: number; status: string; sentAt: string | null; error: string | null }[];
};

export async function readCampaignDetail(campaignId: string): Promise<CampaignDetail | null> {
  const supabase = await createClient();
  const { data: c, error } = await supabase.schema('crm').from('email_campaigns').select('id, name, status, recipient_count, paused_reason, created_by, approved_by, created_at, audience').eq('id', campaignId).maybeSingle();
  if (error) unreadable('readCampaignDetail', error);
  if (!c) return null;
  const [steps, recipients, sends] = await Promise.all([
    supabase.schema('crm').from('email_campaign_steps').select('step_number, delay_days, template_id').eq('campaign_id', campaignId).order('step_number'),
    supabase.schema('crm').from('email_campaign_recipients').select('status').eq('campaign_id', campaignId),
    supabase.schema('crm').from('email_outreach_sends').select('email, step_number, status, sent_at, error, reserved_at').eq('campaign_id', campaignId).order('reserved_at', { ascending: false }).limit(200),
  ]);
  if (steps.error) unreadable('readCampaignDetail.steps', steps.error);
  if (recipients.error) unreadable('readCampaignDetail.recipients', recipients.error);
  if (sends.error) unreadable('readCampaignDetail.sends', sends.error);
  const templateIds = [...new Set((steps.data ?? []).map((s) => s.template_id))];
  const templates = templateIds.length > 0 ? await supabase.schema('crm').from('email_templates').select('id, name').in('id', templateIds) : { data: [], error: null };
  if (templates.error) unreadable('readCampaignDetail.templates', templates.error);
  const name = new Map((templates.data ?? []).map((t) => [t.id, t.name]));
  const byStatus: Record<string, number> = {};
  for (const r of recipients.data ?? []) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const tally = { sent: 0, bounced: 0, failed: 0, reserved: 0 };
  for (const s of sends.data ?? []) if (s.status in tally) tally[s.status as keyof typeof tally] += 1;
  return {
    campaign: { id: c.id, name: c.name, status: c.status, recipientCount: c.recipient_count, pausedReason: c.paused_reason, createdBy: c.created_by, approvedBy: c.approved_by, createdAt: c.created_at, audience: (c.audience ?? {}) as Record<string, unknown> },
    steps: (steps.data ?? []).map((s) => ({ stepNumber: s.step_number, templateName: name.get(s.template_id) ?? '—', delayDays: s.delay_days })),
    byStatus,
    sends: tally,
    recent: (sends.data ?? []).slice(0, 25).map((s) => ({ email: s.email, stepNumber: s.step_number, status: s.status, sentAt: s.sent_at, error: s.error })),
  };
}

export type SuppressionView = { email: string; reason: string; source: string; createdAt: string };

export async function listSuppressions(limit = 100): Promise<SuppressionView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('email_suppressions').select('email, reason, source, created_at').order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('listSuppressions', error);
  return (data ?? []).map((s) => ({ email: s.email, reason: s.reason, source: s.source, createdAt: s.created_at }));
}
