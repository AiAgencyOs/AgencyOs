import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { parseProspectCsv, type ProspectRow } from './csv';

/**
 * Email outreach's write surface. Thin on purpose: every rule (suppression, lawful basis, second-person
 * approval, the frozen audience, the daily cap) lives in the database doors and the chokepoint; this layer
 * checks the capability to keep a reader off a form they cannot submit and turns an outcome into a sentence.
 */

const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

async function writer(): Promise<Result<true>> {
  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to run outreach.');
  return ok(true);
}

export async function saveOutreachSettings(input: {
  senderName: string;
  postalAddress: string;
  replyTo: string;
  dailyCap: number;
  bouncePausePercent: number;
  coldBasisEnabled?: boolean;
}): Promise<Result<true>> {
  const gate = await writer();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_outreach_settings', {
    p_sender_name: input.senderName,
    p_postal_address: input.postalAddress,
    p_reply_to: input.replyTo,
    p_daily_cap: input.dailyCap,
    p_bounce_pause_percent: input.bouncePausePercent,
    p_cold_basis_enabled: input.coldBasisEnabled,
  });
  if (error) return err('INTERNAL', 'Could not save the outreach settings.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'saved':
      return ok(true);
    case 'owner_only':
      return err('FORBIDDEN', 'Only the owner can switch cold business outreach on or off - it is a legal position, not a preference.');
    case 'invalid':
      return err('VALIDATION', 'The daily cap must be 1-500 and the bounce threshold 1-50%.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may change the outreach settings.');
  }
}

export async function importProspects(input: { csv: string; provenance: string; lawfulBasis: ProspectRow['lawfulBasis'] }): Promise<Result<{ inserted: number; duplicates: number; suppressed: number; invalid: number; problems: string[] }>> {
  const gate = await writer();
  if (!gate.ok) return gate;
  const parsed = parseProspectCsv(input.csv, { provenance: input.provenance, lawfulBasis: input.lawfulBasis });
  if (parsed.rows.length === 0) return err('VALIDATION', parsed.problems[0]?.problem ?? 'Nothing to import.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('add_outreach_prospects', { p_rows: parsed.rows as never });
  if (error) return err('INTERNAL', 'Could not import the list.');
  const row = first<{ inserted: number; duplicates: number; suppressed: number; invalid: number; problems: { row: number; problem: string }[] }>(data);
  if (!row) return err('INTERNAL', 'Could not import the list.');
  const problems = [...parsed.problems.map((p) => `line ${p.line}: ${p.problem}`), ...(row.problems ?? []).map((p) => `row ${p.row}: ${p.problem}`)];
  return ok({ inserted: row.inserted, duplicates: row.duplicates, suppressed: row.suppressed, invalid: row.invalid + parsed.problems.length, problems });
}

export async function createTemplate(input: { name: string; language: string; subject: string; body: string }): Promise<Result<{ id: string }>> {
  const gate = await writer();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('create_email_template', { p_name: input.name, p_language: input.language, p_subject: input.subject, p_body: input.body });
  if (error) return err('INTERNAL', 'Could not save the template.');
  const row = first<{ outcome?: string; template_id?: string | null }>(data);
  if (row?.outcome === 'created' && row.template_id) return ok({ id: row.template_id });
  if (row?.outcome?.startsWith('refused:')) return err('VALIDATION', row.outcome.replace('refused: ', ''));
  return err('FORBIDDEN', 'You do not have permission to write templates.');
}

export async function approveTemplate(templateId: string): Promise<Result<true>> {
  const gate = await writer();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('approve_email_template', { p_template_id: templateId });
  if (error) return err('INTERNAL', 'Could not approve the template.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'approved':
      return ok(true);
    case 'author_cannot_approve':
      return err('FORBIDDEN', 'You wrote this template - a second person must approve words that go to strangers.');
    case 'not_a_draft':
      return err('CONFLICT', 'That template is not a draft.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may approve a template.');
  }
}

export async function createCampaign(input: { name: string; tags: string[]; languages: string[]; limit: number | null; steps: { templateId: string; delayDays: number }[] }): Promise<Result<{ id: string }>> {
  const gate = await writer();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('create_email_campaign', {
    p_name: input.name,
    p_audience: { statuses: ['new'], tags: input.tags, languages: input.languages, ...(input.limit ? { limit: input.limit } : {}) } as never,
    p_steps: input.steps as never,
  });
  if (error) return err('INTERNAL', 'Could not create the campaign.');
  const row = first<{ outcome?: string; campaign_id?: string | null }>(data);
  if (row?.outcome === 'created' && row.campaign_id) return ok({ id: row.campaign_id });
  if (row?.outcome === 'template_not_approved') return err('CONFLICT', 'Every step needs an approved template.');
  if (row?.outcome === 'needs_name') return err('VALIDATION', 'Name the campaign.');
  if (row?.outcome === 'needs_1_to_3_steps') return err('VALIDATION', 'A campaign has one to three steps.');
  return err('FORBIDDEN', 'You do not have permission to create campaigns.');
}

export async function approveCampaign(campaignId: string): Promise<Result<{ recipients: number }>> {
  const gate = await writer();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('approve_email_campaign', { p_campaign_id: campaignId });
  if (error) return err('INTERNAL', 'Could not approve the campaign.');
  const row = first<{ outcome?: string; recipient_count?: number | null }>(data);
  switch (row?.outcome) {
    case 'approved':
      return ok({ recipients: row.recipient_count ?? 0 });
    case 'creator_cannot_approve':
      return err('FORBIDDEN', 'You wrote this campaign - a second person approves it.');
    case 'identity_missing':
      return err('CONFLICT', 'Set the sender name and postal address in the outreach settings first - every email must carry them.');
    case 'nobody_reachable':
      return err('CONFLICT', 'Nobody in this audience can be emailed yet: they are suppressed, have no email consent, or cold outreach is not switched on.');
    case 'not_a_draft':
      return err('CONFLICT', 'That campaign is already approved.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may approve a campaign.');
  }
}

export async function setCampaignState(campaignId: string, to: 'running' | 'paused' | 'cancelled', note?: string): Promise<Result<true>> {
  const gate = await writer();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_email_campaign_state', { p_campaign_id: campaignId, p_to: to, p_note: note });
  if (error) return err('INTERNAL', 'Could not change the campaign.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'running':
    case 'paused':
    case 'cancelled':
      return ok(true);
    case 'needs_note':
      return err('VALIDATION', 'Say why it is safe to resume - this run stopped for a reason.');
    case 'bad_transition':
      return err('CONFLICT', 'The campaign cannot move to that state from where it is.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may start, pause or cancel a campaign.');
  }
}

export async function suppress(email: string, reason: string, note: string): Promise<Result<true>> {
  const gate = await writer();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('suppress_email', { p_email: email, p_reason: reason, p_note: note });
  if (error) return err('INTERNAL', 'Could not record the suppression.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'suppressed':
    case 'already_suppressed':
      return ok(true);
    case 'bad_email':
      return err('VALIDATION', 'That is not an email address.');
    case 'bad_reason':
      return err('VALIDATION', 'Choose a reason.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may suppress an address.');
  }
}

export async function markReplied(prospectId: string): Promise<Result<true>> {
  const gate = await writer();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('mark_prospect_replied', { p_prospect_id: prospectId });
  if (error) return err('INTERNAL', 'Could not record the reply.');
  return first<{ outcome?: string }>(data)?.outcome === 'replied' ? ok(true) : err('NOT_FOUND', 'That person was not found.');
}

export async function convertProspect(prospectId: string): Promise<Result<{ leadId: string | null }>> {
  const gate = await writer();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('convert_prospect', { p_prospect_id: prospectId });
  if (error) return err('INTERNAL', 'Could not convert the prospect.');
  const row = first<{ outcome?: string; lead_id?: string | null }>(data);
  if (row?.outcome === 'converted' || row?.outcome === 'already_converted') return ok({ leadId: row.lead_id ?? null });
  return err('NOT_FOUND', 'That person was not found.');
}
