import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { ACQUISITION_CHANNELS, type AcquisitionChannel, type IcpDefinition } from './schema';

/** Reads for the Lead Generation screens. Every failed read refuses (G-054): an empty list is never a hidden error. */

export type ChannelSettings = {
  channel: AcquisitionChannel;
  enabled: boolean;
  paused: boolean;
  pauseReason: string | null;
  pausedAt: string | null;
  monthlyQualifiedTarget: number | null;
  monthlyBudgetMinor: number | null;
  dailyLimit: number | null;
};

/** One entry per engine, in the fixed order, whether or not the organisation has been seeded yet. */
export async function readChannelSettings(): Promise<{ seeded: boolean; channels: ChannelSettings[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('acquisition_channels')
    .select('channel, enabled, paused, pause_reason, paused_at, monthly_qualified_target, monthly_budget_minor, daily_limit');
  if (error) unreadable('readChannelSettings', error);
  const byChannel = new Map((data ?? []).map((r) => [r.channel, r]));
  return {
    seeded: (data ?? []).length > 0,
    channels: ACQUISITION_CHANNELS.map((channel) => {
      const r = byChannel.get(channel);
      return {
        channel,
        enabled: r?.enabled ?? false,
        paused: r?.paused ?? false,
        pauseReason: r?.pause_reason ?? null,
        pausedAt: r?.paused_at ?? null,
        monthlyQualifiedTarget: r?.monthly_qualified_target ?? null,
        monthlyBudgetMinor: r?.monthly_budget_minor === null || r?.monthly_budget_minor === undefined ? null : Number(r.monthly_budget_minor),
        dailyLimit: r?.daily_limit ?? null,
      };
    }),
  };
}

export type TargetServiceView = { id: string; name: string; description: string | null; priority: number; active: boolean };

export async function listTargetServices(): Promise<TargetServiceView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('target_services').select('id, name, description, priority, active').order('priority').order('name');
  if (error) unreadable('listTargetServices', error);
  return (data ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description, priority: s.priority, active: s.active }));
}

export type IcpView = { version: number; definition: IcpDefinition; note: string | null; createdAt: string } | null;

export async function readCurrentIcp(): Promise<{ current: IcpView; versions: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('icp_versions').select('version, definition, note, created_at').order('version', { ascending: false }).limit(1);
  if (error) unreadable('readCurrentIcp', error);
  const { count, error: countError } = await supabase.schema('crm').from('icp_versions').select('version', { count: 'exact', head: true });
  if (countError) unreadable('readCurrentIcp.count', countError);
  const row = data?.[0];
  return {
    current: row ? { version: row.version, definition: (row.definition ?? {}) as IcpDefinition, note: row.note, createdAt: row.created_at } : null,
    versions: count ?? 0,
  };
}

export type SourceCount = { source: string; leads: number; qualified: number; won: number };

/**
 * What the CRM already knows, by the source it was recorded under. Real counts from crm.leads - nothing is
 * estimated. `won` is leads that converted (the lead-level WON; ADM-10). Bounded to the most recent 5,000
 * leads so a large book cannot make the page unbounded; `truncated` says so rather than hiding it.
 */
export async function readLeadsBySource(): Promise<{ rows: SourceCount[]; total: number; truncated: boolean }> {
  const supabase = await createClient();
  const LIMIT = 5000;
  const { data, error } = await supabase.schema('crm').from('leads').select('source, status').order('created_at', { ascending: false }).limit(LIMIT);
  if (error) unreadable('readLeadsBySource', error);
  const by = new Map<string, SourceCount>();
  for (const l of data ?? []) {
    const row = by.get(l.source) ?? { source: l.source, leads: 0, qualified: 0, won: 0 };
    row.leads += 1;
    if (l.status === 'qualified' || l.status === 'converted') row.qualified += 1;
    if (l.status === 'converted') row.won += 1;
    by.set(l.source, row);
  }
  return { rows: [...by.values()].sort((a, b) => b.leads - a.leads), total: (data ?? []).length, truncated: (data ?? []).length >= LIMIT };
}

export type DuplicateReviewView = {
  id: string;
  reason: string;
  createdAt: string;
  signals: Record<string, unknown>;
  a: { id: string; name: string; email: string | null; phone: string | null; company: string | null; reachableVia: string | null };
  b: { id: string; name: string; email: string | null; phone: string | null; company: string | null; reachableVia: string | null };
};

/** Open suspected duplicates, oldest first, with both people named so a person can judge without opening anything. */
export async function listOpenDuplicateReviews(limit = 50): Promise<{ rows: DuplicateReviewView[]; totalOpen: number }> {
  const supabase = await createClient();
  const { data, error, count } = await supabase.schema('crm').from('duplicate_reviews')
    .select('id, reason, signals, created_at, contact_a, contact_b', { count: 'exact' })
    .eq('status', 'open').order('created_at').limit(limit);
  if (error) unreadable('listOpenDuplicateReviews', error);
  const ids = [...new Set((data ?? []).flatMap((r) => [r.contact_a, r.contact_b]))];
  const people = new Map<string, DuplicateReviewView['a']>();
  if (ids.length > 0) {
    const { data: contacts, error: contactsError } = await supabase.schema('crm').from('contacts').select('id, full_name, email, phone, company, reachable_via').in('id', ids);
    if (contactsError) unreadable('listOpenDuplicateReviews.contacts', contactsError);
    for (const c of contacts ?? []) people.set(c.id, { id: c.id, name: c.full_name, email: c.email, phone: c.phone, company: c.company, reachableVia: c.reachable_via });
  }
  const unknown = (id: string): DuplicateReviewView['a'] => ({ id, name: 'Unknown contact', email: null, phone: null, company: null, reachableVia: null });
  return {
    totalOpen: count ?? (data ?? []).length,
    rows: (data ?? []).map((r) => ({
      id: r.id, reason: r.reason, createdAt: r.created_at, signals: (r.signals ?? {}) as Record<string, unknown>,
      a: people.get(r.contact_a) ?? unknown(r.contact_a), b: people.get(r.contact_b) ?? unknown(r.contact_b),
    })),
  };
}

export type IdentitySummary = {
  keys: Record<string, number>;
  touchpointsByChannel: Record<string, number>;
  ownersByAgent: Record<string, number>;
  truncated: boolean;
};

/** Counts the Identity screen shows. Bounded reads: a large book cannot make the page unbounded, and says so. */
export async function readIdentitySummary(): Promise<IdentitySummary> {
  const supabase = await createClient();
  const LIMIT = 20000;
  const [keys, touches, owners] = await Promise.all([
    supabase.schema('crm').from('identity_keys').select('kind').limit(LIMIT),
    supabase.schema('crm').from('lead_touchpoints').select('channel').limit(LIMIT),
    supabase.schema('crm').from('lead_conversation_owner').select('owner').limit(LIMIT),
  ]);
  const { data: keyRows, error: keysError } = keys;
  if (keysError) unreadable('readIdentitySummary.keys', keysError);
  const { data: touchRows, error: touchError } = touches;
  if (touchError) unreadable('readIdentitySummary.touchpoints', touchError);
  const { data: ownerRows, error: ownerError } = owners;
  if (ownerError) unreadable('readIdentitySummary.owners', ownerError);
  const tally = (rows: { [k: string]: string }[] | null, field: string) => {
    const out: Record<string, number> = {};
    for (const r of rows ?? []) out[r[field] as string] = (out[r[field] as string] ?? 0) + 1;
    return out;
  };
  return {
    keys: tally(keyRows, 'kind'),
    touchpointsByChannel: tally(touchRows, 'channel'),
    ownersByAgent: tally(ownerRows, 'owner'),
    truncated: (keyRows ?? []).length >= LIMIT || (touchRows ?? []).length >= LIMIT || (ownerRows ?? []).length >= LIMIT,
  };
}

export type HandoffSettings = { businessNumber: string | null; linkTtlDays: number };

export async function readHandoffSettings(): Promise<HandoffSettings> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('whatsapp_handoff_settings').select('business_number, link_ttl_days').maybeSingle();
  if (error) unreadable('readHandoffSettings', error);
  return { businessNumber: data?.business_number ?? null, linkTtlDays: data?.link_ttl_days ?? 14 };
}

export type HandoffView = {
  id: string;
  status: string;
  sourceChannel: string;
  sourcePlatform: string | null;
  sourceAgent: string;
  leadId: string;
  leadTitle: string;
  expiresAt: string;
  createdAt: string;
  consumeOutcome: string | null;
  bindOutcome: string | null;
  nextAction: string | null;
};

/** Recent handoffs, newest first. The token hash is not even readable by a session, so it cannot appear here. */
export async function listHandoffs(limit = 30): Promise<{ rows: HandoffView[]; live: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('channel_handoffs')
    .select('id, status, source_channel, source_platform, source_agent, lead_id, expires_at, created_at, consume_outcome, bind_outcome, next_action')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('listHandoffs', error);
  const ids = [...new Set((data ?? []).map((h) => h.lead_id))];
  const titles = new Map<string, string>();
  if (ids.length > 0) {
    const { data: leads, error: leadsError } = await supabase.schema('crm').from('leads').select('id, title').in('id', ids);
    if (leadsError) unreadable('listHandoffs.leads', leadsError);
    for (const l of leads ?? []) titles.set(l.id, l.title);
  }
  const rows = (data ?? []).map((h) => ({
    id: h.id, status: h.status, sourceChannel: h.source_channel, sourcePlatform: h.source_platform, sourceAgent: h.source_agent,
    leadId: h.lead_id, leadTitle: titles.get(h.lead_id) ?? 'Lead', expiresAt: h.expires_at, createdAt: h.created_at,
    consumeOutcome: h.consume_outcome, bindOutcome: h.bind_outcome, nextAction: h.next_action,
  }));
  return { rows, live: rows.filter((h) => ['CREATED', 'OPENED', 'RESOLVED'].includes(h.status)).length };
}

export type IntegrationView = {
  id: string;
  provider: string;
  environment: string;
  label: string;
  status: string;
  verification: string;
  adapterImplemented: boolean;
  accountRef: string | null;
  capabilities: Record<string, string>;
  health: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorClass: string | null;
  lastError: string | null;
  statusReason: string | null;
  credentials: { id: string; name: string; hint: string | null; expiresOn: string | null; rotatedAt: string | null }[];
};

/** Connections with their credential METADATA only: the columns a session may read stop short of the secret material. */
export async function listIntegrations(): Promise<IntegrationView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('acquisition_integrations')
    .select('id, provider, environment, label, status, verification, adapter_implemented, account_ref, capabilities, health, last_checked_at, last_success_at, last_error_class, last_error, status_reason')
    .order('provider').order('environment');
  if (error) unreadable('listIntegrations', error);
  const { data: creds, error: credsError } = await supabase.schema('crm').from('connector_credentials')
    .select('id, integration_id, name, hint, expires_on, rotated_at').eq('status', 'active');
  if (credsError) unreadable('listIntegrations.credentials', credsError);
  return (data ?? []).map((i) => ({
    id: i.id, provider: i.provider, environment: i.environment, label: i.label, status: i.status, verification: i.verification,
    adapterImplemented: i.adapter_implemented, accountRef: i.account_ref, capabilities: (i.capabilities ?? {}) as Record<string, string>,
    health: i.health, lastCheckedAt: i.last_checked_at, lastSuccessAt: i.last_success_at, lastErrorClass: i.last_error_class,
    lastError: i.last_error, statusReason: i.status_reason,
    credentials: (creds ?? []).filter((c) => c.integration_id === i.id).map((c) => ({ id: c.id, name: c.name, hint: c.hint, expiresOn: c.expires_on, rotatedAt: c.rotated_at })),
  }));
}

export type PolicyView = { actionType: string; mode: string; approvalAboveMinor: number | null; escalateAboveMinor: number | null; updatedAt: string };

export async function listPolicies(): Promise<PolicyView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('acquisition_policies').select('action_type, mode, approval_above_minor, escalate_above_minor, updated_at');
  if (error) unreadable('listPolicies', error);
  return (data ?? []).map((p) => ({
    actionType: p.action_type, mode: p.mode,
    approvalAboveMinor: p.approval_above_minor === null ? null : Number(p.approval_above_minor),
    escalateAboveMinor: p.escalate_above_minor === null ? null : Number(p.escalate_above_minor),
    updatedAt: p.updated_at,
  }));
}

export type DecisionView = { actionType: string; channel: string | null; decision: string; reason: string; createdAt: string };

export async function listRecentDecisions(limit = 15): Promise<DecisionView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('acquisition_decisions').select('action_type, channel, decision, reason, created_at').order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('listRecentDecisions', error);
  return (data ?? []).map((d) => ({ actionType: d.action_type, channel: d.channel, decision: d.decision, reason: d.reason, createdAt: d.created_at }));
}

export type SubtaskView = {
  id: string;
  kind: string;
  status: string;
  assignee: string | null;
  requestedByOwner: string;
  returnedToOwner: string | null;
  objective: string;
  leadId: string;
  leadTitle: string;
  meetingId: string | null;
  proposalId: string | null;
  failureReason: string | null;
  progress: Record<string, unknown>;
  createdAt: string;
};

/** Recent subtasks, open ones first. */
export async function listSubtasks(limit = 30): Promise<{ rows: SubtaskView[]; open: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('subtask_requests')
    .select('id, kind, status, assignee, requested_by_owner, returned_to_owner, objective, lead_id, meeting_id, proposal_id, failure_reason, progress, created_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('listSubtasks', error);
  const ids = [...new Set((data ?? []).map((s) => s.lead_id))];
  const titles = new Map<string, string>();
  if (ids.length > 0) {
    const { data: leads, error: leadsError } = await supabase.schema('crm').from('leads').select('id, title').in('id', ids);
    if (leadsError) unreadable('listSubtasks.leads', leadsError);
    for (const l of leads ?? []) titles.set(l.id, l.title);
  }
  const rows = (data ?? []).map((s) => ({
    id: s.id, kind: s.kind, status: s.status, assignee: s.assignee, requestedByOwner: s.requested_by_owner, returnedToOwner: s.returned_to_owner,
    objective: s.objective, leadId: s.lead_id, leadTitle: titles.get(s.lead_id) ?? 'Lead', meetingId: s.meeting_id, proposalId: s.proposal_id,
    failureReason: s.failure_reason, progress: (s.progress ?? {}) as Record<string, unknown>, createdAt: s.created_at,
  }));
  rows.sort((a, b) => Number(['REQUESTED', 'IN_PROGRESS'].includes(b.status)) - Number(['REQUESTED', 'IN_PROGRESS'].includes(a.status)));
  return { rows, open: rows.filter((r) => ['REQUESTED', 'IN_PROGRESS'].includes(r.status)).length };
}
