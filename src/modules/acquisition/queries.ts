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

/** Pairs an administrator judged the same person whose records have not been joined yet (neither side is already merged). */
export async function listConfirmedUnmerged(limit = 50): Promise<DuplicateReviewView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('duplicate_reviews')
    .select('id, reason, signals, created_at, contact_a, contact_b').eq('status', 'confirmed_same').order('decided_at', { ascending: false }).limit(limit);
  if (error) unreadable('listConfirmedUnmerged', error);
  const ids = [...new Set((data ?? []).flatMap((r) => [r.contact_a, r.contact_b]))];
  const { data: contacts, error: contactsError } = ids.length === 0
    ? { data: [], error: null }
    : await supabase.schema('crm').from('contacts').select('id, full_name, email, phone, company, reachable_via, merged_into_contact_id').in('id', ids);
  if (contactsError) unreadable('listConfirmedUnmerged.contacts', contactsError);
  const people = new Map((contacts ?? []).map((c) => [c.id, c]));
  const view = (id: string): DuplicateReviewView['a'] => {
    const c = people.get(id);
    return c ? { id: c.id, name: c.full_name, email: c.email, phone: c.phone, company: c.company, reachableVia: c.reachable_via } : { id, name: 'Unknown contact', email: null, phone: null, company: null, reachableVia: null };
  };
  return (data ?? [])
    .filter((r) => !people.get(r.contact_a)?.merged_into_contact_id && !people.get(r.contact_b)?.merged_into_contact_id)
    .map((r) => ({ id: r.id, reason: r.reason, createdAt: r.created_at, signals: (r.signals ?? {}) as Record<string, unknown>, a: view(r.contact_a), b: view(r.contact_b) }));
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

export type FunnelView = Record<string, number>;

/** The email funnel, derived from the records themselves (prospects, qualifications, subtasks, lead outcomes) - not from a counter. */
export async function readEmailFunnel(): Promise<FunnelView> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('email_funnel', {});
  if (error) unreadable('readEmailFunnel', error);
  const out: FunnelView = {};
  for (const r of (data ?? []) as { stage: string | null; n: number | null }[]) if (r.stage) out[r.stage] = Number(r.n ?? 0);
  return out;
}

export type QualificationModelView = { version: number; weights: Record<string, number>; note: string | null; createdAt: string } | null;

export async function readQualificationModel(): Promise<{ current: QualificationModelView; versions: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('qualification_models').select('version, weights, note, created_at').order('version', { ascending: false }).limit(1);
  if (error) unreadable('readQualificationModel', error);
  const { count, error: countError } = await supabase.schema('crm').from('qualification_models').select('version', { count: 'exact', head: true });
  if (countError) unreadable('readQualificationModel.count', countError);
  const row = data?.[0];
  return { current: row ? { version: row.version, weights: (row.weights ?? {}) as Record<string, number>, note: row.note, createdAt: row.created_at } : null, versions: count ?? 0 };
}

export type BlockView = { id: string; kind: string; value: string; reason: string; createdAt: string };

export async function listActiveBlocks(): Promise<BlockView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('blocked_prospects').select('id, kind, value, reason, created_at').is('lifted_at', null).order('created_at', { ascending: false });
  if (error) unreadable('listActiveBlocks', error);
  return (data ?? []).map((b) => ({ id: b.id, kind: b.kind, value: b.value, reason: b.reason, createdAt: b.created_at }));
}

export type QualificationView = { id: string; prospectEmail: string; decision: string; score: number; threshold: number; disqualifiers: string[]; missing: string[]; createdAt: string };

export async function listRecentQualifications(limit = 10): Promise<QualificationView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('prospect_qualifications').select('id, prospect_id, decision, score, threshold, disqualifiers, missing_information, created_at').order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('listRecentQualifications', error);
  const ids = [...new Set((data ?? []).map((q) => q.prospect_id))];
  const emails = new Map<string, string>();
  if (ids.length > 0) {
    const { data: prospects, error: prospectsError } = await supabase.schema('crm').from('outreach_prospects').select('id, email').in('id', ids);
    if (prospectsError) unreadable('listRecentQualifications.prospects', prospectsError);
    for (const p of prospects ?? []) emails.set(p.id, p.email);
  }
  return (data ?? []).map((q) => ({
    id: q.id, prospectEmail: emails.get(q.prospect_id) ?? 'unknown', decision: q.decision, score: q.score, threshold: q.threshold,
    disqualifiers: Array.isArray(q.disqualifiers) ? (q.disqualifiers as string[]) : [], missing: Array.isArray(q.missing_information) ? (q.missing_information as string[]) : [],
    createdAt: q.created_at,
  }));
}

export type ContentQueueRow = {
  itemId: string; versionId: string; version: number; platform: string; objective: string; format: string; title: string; bodyPreview: string;
  state: string; status: string; scheduledFor: string | null; blocking: string[]; warnings: string[]; createdAt: string;
};

/** The content a person works, with the specification's labels derived from the approval engine. */
export async function listContentQueue(limit = 40): Promise<ContentQueueRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('content_queue', { p_limit: limit });
  if (error) unreadable('listContentQueue', error);
  return ((data ?? []) as { item_id: string | null; version_id: string | null; version: number | null; platform: string | null; objective: string | null; format: string | null; title: string | null; body_preview: string | null; state: string | null; status: string | null; scheduled_for: string | null; review: { blocking?: string[]; warnings?: string[] } | null; created_at: string | null }[])
    .filter((r) => r.item_id && r.version_id)
    .map((r) => ({
      itemId: r.item_id as string, versionId: r.version_id as string, version: r.version ?? 1, platform: r.platform ?? '', objective: r.objective ?? '', format: r.format ?? '',
      title: r.title ?? '', bodyPreview: r.body_preview ?? '', state: r.state ?? '', status: r.status ?? r.state ?? '', scheduledFor: r.scheduled_for,
      blocking: Array.isArray(r.review?.blocking) ? r.review.blocking : [], warnings: Array.isArray(r.review?.warnings) ? r.review.warnings : [], createdAt: r.created_at ?? '',
    }));
}

export type StrategyView = { id: string; platform: string; horizon: number; version: number; status: string; rationale: string | null; content: Record<string, unknown>; createdAt: string };

export async function listSocialStrategies(): Promise<StrategyView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('social_strategies').select('id, platform, horizon_months, version, status, rationale, content, created_at')
    .order('platform').order('horizon_months').order('version', { ascending: false }).limit(40);
  if (error) unreadable('listSocialStrategies', error);
  return (data ?? []).map((s) => ({ id: s.id, platform: s.platform, horizon: s.horizon_months, version: s.version, status: s.status, rationale: s.rationale, content: (s.content ?? {}) as Record<string, unknown>, createdAt: s.created_at }));
}

export type PerformanceRow = { platform: string; objective: string; format: string; published: number; impressions: number; engagements: number; clicks: number };

export async function readSocialPerformance(): Promise<PerformanceRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('social_performance', {});
  if (error) unreadable('readSocialPerformance', error);
  return ((data ?? []) as { platform: string | null; objective: string | null; format: string | null; published: number | null; impressions: number | null; engagements: number | null; clicks: number | null }[])
    .map((r) => ({ platform: r.platform ?? '', objective: r.objective ?? '', format: r.format ?? '', published: Number(r.published ?? 0), impressions: Number(r.impressions ?? 0), engagements: Number(r.engagements ?? 0), clicks: Number(r.clicks ?? 0) }));
}

export type AdVersionView = {
  id: string; version: number; state: string; changeKind: string; changeAmountMinor: number; budgetDailyMinor: number; budgetTotalMinor: number | null;
  startDate: string | null; endDate: string | null; problems: string[]; createdAt: string;
};
export type AdCampaignView = {
  id: string; platform: string; name: string; targetService: string | null; status: string; pending: string | null; currency: string;
  liveVersionId: string | null; versions: AdVersionView[];
};

/** Campaigns with their newest versions. A pending pause/resume/end is shown as pending: the platform has not confirmed it. */
export async function listAdCampaigns(platform: string): Promise<AdCampaignView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('ad_campaigns').select('id, platform, name, target_service, status, provider_sync_pending, currency, live_version_id')
    .eq('platform', platform).order('created_at', { ascending: false }).limit(30);
  if (error) unreadable('listAdCampaigns', error);
  const ids = (data ?? []).map((c) => c.id);
  const byCampaign = new Map<string, AdVersionView[]>();
  if (ids.length > 0) {
    const { data: versions, error: versionsError } = await supabase.schema('crm').from('ad_campaign_versions')
      .select('id, campaign_id, version, state, change_kind, change_amount_minor, budget_daily_minor, budget_total_minor, start_date, end_date, review, created_at').in('campaign_id', ids).order('version', { ascending: false }).limit(300);
    if (versionsError) unreadable('listAdCampaigns.versions', versionsError);
    for (const v of versions ?? []) {
      const problems = (v.review as { problems?: unknown } | null)?.problems;
      const list = byCampaign.get(v.campaign_id) ?? [];
      if (list.length < 5) list.push({ id: v.id, version: v.version, state: v.state, changeKind: v.change_kind, changeAmountMinor: v.change_amount_minor, budgetDailyMinor: v.budget_daily_minor, budgetTotalMinor: v.budget_total_minor, startDate: v.start_date, endDate: v.end_date, problems: Array.isArray(problems) ? (problems as string[]) : [], createdAt: v.created_at });
      byCampaign.set(v.campaign_id, list);
    }
  }
  return (data ?? []).map((c) => ({ id: c.id, platform: c.platform, name: c.name, targetService: c.target_service, status: c.status, pending: c.provider_sync_pending, currency: c.currency, liveVersionId: c.live_version_id, versions: byCampaign.get(c.id) ?? [] }));
}

export type AdOutcomeView = {
  campaignId: string; platform: string; name: string; spendMinor: number; impressions: number; clicks: number; platformLeads: number; leads: number; qualified: number; meetings: number; quotes: number; won: number; revenueMinor: number;
  costPerLeadMinor: number | null; costPerQualifiedMinor: number | null; costPerMeetingMinor: number | null; costPerWonMinor: number | null; insufficientData: boolean;
};

/** Results read from the CRM by first touch. A cost with nothing to divide by is null, never a guess. */
export async function readAdOutcomes(): Promise<AdOutcomeView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('ad_outcomes', {});
  if (error) unreadable('readAdOutcomes', error);
  const n = (v: number | null) => (v === null ? null : Number(v));
  return (data ?? []).filter((r) => r.campaign_id).map((r) => ({
    campaignId: r.campaign_id as string, platform: r.platform ?? '', name: r.name ?? '', spendMinor: Number(r.spend_minor ?? 0), impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0),
    platformLeads: Number(r.platform_leads ?? 0), leads: Number(r.leads ?? 0), qualified: Number(r.qualified ?? 0), meetings: Number(r.meetings ?? 0), quotes: Number(r.quotes ?? 0), won: Number(r.won ?? 0),
    revenueMinor: Number(r.revenue_minor ?? 0), costPerLeadMinor: n(r.cost_per_lead_minor), costPerQualifiedMinor: n(r.cost_per_qualified_minor), costPerMeetingMinor: n(r.cost_per_meeting_minor),
    costPerWonMinor: n(r.cost_per_won_minor), insufficientData: r.insufficient_data !== false,
  }));
}

export type AdRecommendationView = { campaignId: string; name: string; recommendation: string };

export async function readAdRecommendations(): Promise<AdRecommendationView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('ad_recommendations', {});
  if (error) unreadable('readAdRecommendations', error);
  return (data ?? []).filter((r) => r.campaign_id && r.recommendation).map((r) => ({ campaignId: r.campaign_id as string, name: r.name ?? '', recommendation: r.recommendation as string }));
}

export type CampaignHealthView = { id: string; campaignId: string; kind: string; severity: string; recommendedAction: string; assessedOn: string };

export async function listCampaignHealth(): Promise<CampaignHealthView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('campaign_health_records').select('id, campaign_id, kind, severity, recommended_action, assessed_on')
    .order('assessed_on', { ascending: false }).limit(40);
  if (error) unreadable('listCampaignHealth', error);
  return (data ?? []).map((h) => ({ id: h.id, campaignId: h.campaign_id, kind: h.kind, severity: h.severity, recommendedAction: h.recommended_action, assessedOn: h.assessed_on }));
}

export type LandingVersionView = { id: string; version: number; state: string; publicUrl: string; headline: string; problems: string[]; checks: Record<string, boolean> | null; verifiedAt: string | null; createdAt: string };
export type LandingPageView = { id: string; name: string; slug: string; status: string; targetService: string | null; liveVersionId: string | null; versions: LandingVersionView[] };

/** Pages with their newest versions; the verification shown is the LATEST check, so a page that stopped matching reads as failed. */
export async function listLandingPages(): Promise<LandingPageView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('landing_pages').select('id, name, slug, status, target_service, live_version_id').order('created_at', { ascending: false }).limit(30);
  if (error) unreadable('listLandingPages', error);
  const ids = (data ?? []).map((p) => p.id);
  const byPage = new Map<string, LandingVersionView[]>();
  if (ids.length > 0) {
    const { data: versions, error: versionsError } = await supabase.schema('crm').from('landing_page_versions').select('id, page_id, version, state, public_url, content, review, created_at').in('page_id', ids).order('version', { ascending: false }).limit(200);
    if (versionsError) unreadable('listLandingPages.versions', versionsError);
    const versionIds = (versions ?? []).map((v) => v.id);
    const latest = new Map<string, { checks: Record<string, boolean>; at: string }>();
    if (versionIds.length > 0) {
      const { data: deployments, error: deploymentsError } = await supabase.schema('crm').from('landing_deployments').select('id, version_id').in('version_id', versionIds);
      if (deploymentsError) unreadable('listLandingPages.deployments', deploymentsError);
      const depIds = (deployments ?? []).map((d) => d.id);
      if (depIds.length > 0) {
        const { data: checks, error: checksError } = await supabase.schema('crm').from('landing_verifications').select('deployment_id, checks, verified_at').in('deployment_id', depIds).order('verified_at', { ascending: false }).limit(300);
        if (checksError) unreadable('listLandingPages.verifications', checksError);
        const versionOf = new Map((deployments ?? []).map((d) => [d.id, d.version_id]));
        for (const c of checks ?? []) {
          const vid = versionOf.get(c.deployment_id);
          if (vid && !latest.has(vid)) latest.set(vid, { checks: c.checks as Record<string, boolean>, at: c.verified_at });
        }
      }
    }
    for (const v of versions ?? []) {
      const problems = (v.review as { problems?: unknown } | null)?.problems;
      const list = byPage.get(v.page_id) ?? [];
      if (list.length < 4) list.push({ id: v.id, version: v.version, state: v.state, publicUrl: v.public_url, headline: String((v.content as { headline?: string } | null)?.headline ?? ''), problems: Array.isArray(problems) ? (problems as string[]) : [], checks: latest.get(v.id)?.checks ?? null, verifiedAt: latest.get(v.id)?.at ?? null, createdAt: v.created_at });
      byPage.set(v.page_id, list);
    }
  }
  return (data ?? []).map((p) => ({ id: p.id, name: p.name, slug: p.slug, status: p.status, targetService: p.target_service, liveVersionId: p.live_version_id, versions: byPage.get(p.id) ?? [] }));
}

export type PortfolioChoice = { id: string; title: string; kind: string };

/** The only things a page may cite as proof. */
export async function listPortfolioChoices(): Promise<PortfolioChoice[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('portfolio_items').select('id, title, kind').eq('is_active', true).order('position').limit(50);
  if (error) unreadable('listPortfolioChoices', error);
  return (data ?? []).map((i) => ({ id: i.id, title: i.title, kind: i.kind }));
}

export type B2bRuleView = { platform: string; offplatform: string; mode: string; note: string | null };
export type B2bSettingsView = { minBudgetMinor: number | null; excludedTerms: string[]; scoreThreshold: number; monthlyConnectsCap: number | null };

export async function readB2bSetup(): Promise<{ ready: boolean; rules: B2bRuleView[]; settings: B2bSettingsView | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('b2b_platform_rules').select('platform, offplatform_contact, automation_mode, note').order('platform');
  if (error) unreadable('readB2bSetup', error);
  const { data: s, error: sError } = await supabase.schema('crm').from('b2b_settings').select('min_budget_minor, excluded_terms, score_threshold, monthly_connects_cap').maybeSingle();
  if (sError) unreadable('readB2bSetup.settings', sError);
  return {
    ready: (data ?? []).length > 0,
    rules: (data ?? []).map((r) => ({ platform: r.platform, offplatform: r.offplatform_contact, mode: r.automation_mode, note: r.note })),
    settings: s ? { minBudgetMinor: s.min_budget_minor, excludedTerms: s.excluded_terms, scoreThreshold: s.score_threshold, monthlyConnectsCap: s.monthly_connects_cap } : null,
  };
}

export type B2bProposalView = { id: string; version: number; state: string; priceMinor: number | null; currency: string; connects: number; problems: string[]; externalRef: string | null; bodyPreview: string };
export type B2bOpportunityView = {
  id: string; platform: string; title: string; url: string | null; status: string; score: number | null; reasons: string[]; budgetMaxMinor: number | null; currency: string;
  skipReason: string | null; leadId: string | null; proposals: B2bProposalView[];
};

export async function listB2bOpportunities(limit = 40): Promise<B2bOpportunityView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('b2b_opportunities')
    .select('id, platform, title, url, status, fit_score, fit_reasons, budget_max_minor, currency, skip_reason, lead_id').order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('listB2bOpportunities', error);
  const ids = (data ?? []).map((o) => o.id);
  const byOpp = new Map<string, B2bProposalView[]>();
  if (ids.length > 0) {
    const { data: proposals, error: proposalsError } = await supabase.schema('crm').from('b2b_proposal_versions')
      .select('id, opportunity_id, version, state, price_minor, currency, connects_cost, review, external_ref, body').in('opportunity_id', ids).order('version', { ascending: false }).limit(200);
    if (proposalsError) unreadable('listB2bOpportunities.proposals', proposalsError);
    for (const p of proposals ?? []) {
      const problems = (p.review as { problems?: unknown } | null)?.problems;
      const list = byOpp.get(p.opportunity_id) ?? [];
      if (list.length < 3) list.push({ id: p.id, version: p.version, state: p.state, priceMinor: p.price_minor, currency: p.currency, connects: p.connects_cost, problems: Array.isArray(problems) ? (problems as string[]) : [], externalRef: p.external_ref, bodyPreview: p.body.slice(0, 160) });
      byOpp.set(p.opportunity_id, list);
    }
  }
  return (data ?? []).map((o) => ({
    id: o.id, platform: o.platform, title: o.title, url: o.url, status: o.status, score: o.fit_score, reasons: Array.isArray(o.fit_reasons) ? (o.fit_reasons as string[]) : [],
    budgetMaxMinor: o.budget_max_minor, currency: o.currency, skipReason: o.skip_reason, leadId: o.lead_id, proposals: byOpp.get(o.id) ?? [],
  }));
}

export type B2bProfileView = { id: string; platform: string; version: number; state: string; headline: string; problems: string[]; evidenceUrl: string | null };

export async function listB2bProfiles(): Promise<B2bProfileView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('b2b_profile_versions').select('id, platform, version, state, content, review, evidence_url').order('created_at', { ascending: false }).limit(30);
  if (error) unreadable('listB2bProfiles', error);
  return (data ?? []).map((p) => {
    const problems = (p.review as { problems?: unknown } | null)?.problems;
    return { id: p.id, platform: p.platform, version: p.version, state: p.state, headline: String((p.content as { headline?: string } | null)?.headline ?? ''), problems: Array.isArray(problems) ? (problems as string[]) : [], evidenceUrl: p.evidence_url };
  });
}

export type B2bOutcomeView = { platform: string; found: number; shortlisted: number; submitted: number; won: number; lost: number; revenueMinor: number; connectsSpent: number; winRatePct: number | null; insufficientData: boolean };

export async function readB2bOutcomes(): Promise<B2bOutcomeView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('b2b_outcomes');
  if (error) unreadable('readB2bOutcomes', error);
  return (data ?? []).filter((r) => r.platform).map((r) => ({
    platform: r.platform as string, found: Number(r.found ?? 0), shortlisted: Number(r.shortlisted ?? 0), submitted: Number(r.submitted ?? 0), won: Number(r.won ?? 0), lost: Number(r.lost ?? 0),
    revenueMinor: Number(r.revenue_minor ?? 0), connectsSpent: Number(r.connects_spent ?? 0), winRatePct: r.win_rate_pct === null ? null : Number(r.win_rate_pct), insufficientData: r.insufficient_data !== false,
  }));
}

export type FunnelRow = {
  channel: string; leads: number; qualified: number; meetings: number; quotes: number; won: number; revenue: Record<string, unknown>; spendMinor: number;
  costPerLeadMinor: number | null; costPerQualifiedMinor: number | null; costPerWonMinor: number | null; lastTouchLeads: number; touchedLeads: number; insufficientData: boolean;
};

/** Results by the channel of each lead's first touch. A cost with nothing to divide by is null, never a guess. */
export async function readAcquisitionFunnel(days: number): Promise<FunnelRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('acquisition_funnel', { p_days: days });
  if (error) unreadable('readAcquisitionFunnel', error);
  const n = (v: number | null) => (v === null ? null : Number(v));
  return (data ?? []).filter((r) => r.channel).map((r) => ({
    channel: r.channel as string, leads: Number(r.leads ?? 0), qualified: Number(r.qualified ?? 0), meetings: Number(r.meetings ?? 0), quotes: Number(r.quotes ?? 0), won: Number(r.won ?? 0),
    revenue: (r.revenue ?? {}) as Record<string, unknown>, spendMinor: Number(r.spend_minor ?? 0), costPerLeadMinor: n(r.cost_per_lead_minor), costPerQualifiedMinor: n(r.cost_per_qualified_minor),
    costPerWonMinor: n(r.cost_per_won_minor), lastTouchLeads: Number(r.last_touch_leads ?? 0), touchedLeads: Number(r.touched_leads ?? 0), insufficientData: r.insufficient_data !== false,
  }));
}

export type GoalRow = {
  channel: string; enabled: boolean; paused: boolean; target: number | null; qualifiedThisMonth: number; pacePct: number | null; onPace: boolean | null;
  budgetMinor: number | null; spendThisMonthMinor: number; budgetUsedPct: number | null; daysElapsed: number; daysInMonth: number;
};

export async function readGoalProgress(): Promise<GoalRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('acquisition_goal_progress');
  if (error) unreadable('readGoalProgress', error);
  return (data ?? []).filter((r) => r.channel).map((r) => ({
    channel: r.channel as string, enabled: r.enabled === true, paused: r.paused === true, target: r.qualified_target, qualifiedThisMonth: Number(r.qualified_this_month ?? 0), pacePct: r.pace_pct,
    onPace: r.on_pace, budgetMinor: r.budget_minor, spendThisMonthMinor: Number(r.spend_this_month_minor ?? 0), budgetUsedPct: r.budget_used_pct, daysElapsed: r.days_elapsed ?? 1, daysInMonth: r.days_in_month ?? 30,
  }));
}

export type FailureRow = { kind: string; severity: string; channel: string | null; refId: string | null; summary: string; since: string | null; advice: string };

export async function listAcquisitionFailures(limit = 60): Promise<FailureRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('acquisition_failures', { p_limit: limit });
  if (error) unreadable('listAcquisitionFailures', error);
  return (data ?? []).filter((r) => r.kind).map((r) => ({ kind: r.kind as string, severity: r.severity ?? 'info', channel: r.channel, refId: r.ref_id, summary: r.summary ?? '', since: r.since, advice: r.advice ?? '' }));
}

export type RecommendationRow = { channel: string; recommendation: string; basis: Record<string, unknown> };

export async function readAcquisitionRecommendations(days: number): Promise<RecommendationRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('acquisition_recommendations', { p_days: days });
  if (error) unreadable('readAcquisitionRecommendations', error);
  return (data ?? []).filter((r) => r.channel && r.recommendation).map((r) => ({ channel: r.channel as string, recommendation: r.recommendation as string, basis: (r.basis ?? {}) as Record<string, unknown> }));
}

export type ProspectChoice = { id: string; email: string; name: string | null; company: string | null };

/** The people on the email list a person may score or check a draft for. */
export async function listOutreachProspects(limit = 40): Promise<ProspectChoice[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('outreach_prospects').select('id, email, full_name, company').order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('listOutreachProspects', error);
  return (data ?? []).map((p) => ({ id: p.id, email: p.email, name: p.full_name, company: p.company }));
}

export type AttributionRow = { channel: string; firstTouch: number; lastTouch: number; linear: number; positionBased: number };

/** The same leads credited four ways. Each column sums to the number of leads, so no model can invent credit. */
export async function readAttributionModels(days: number): Promise<AttributionRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('acquisition_attribution_models', { p_days: days });
  if (error) unreadable('readAttributionModels', error);
  return (data ?? []).filter((r) => r.channel).map((r) => ({ channel: r.channel as string, firstTouch: Number(r.first_touch ?? 0), lastTouch: Number(r.last_touch ?? 0), linear: Number(r.linear ?? 0), positionBased: Number(r.position_based ?? 0) }));
}

export type TrendRow = { weekStart: string; channel: string; leads: number; qualified: number };

export async function readAcquisitionTrend(weeks: number): Promise<TrendRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('acquisition_trend', { p_weeks: weeks });
  if (error) unreadable('readAcquisitionTrend', error);
  return (data ?? []).filter((r) => r.week_start && r.channel).map((r) => ({ weekStart: r.week_start as string, channel: r.channel as string, leads: Number(r.leads ?? 0), qualified: Number(r.qualified ?? 0) }));
}
