import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Phase 8A gaps log 1 reads. Every figure is read as stored or from the database function that derives it: the next-action queue is `cs_next_actions` (a fixed
 * rank by kind, nothing stored), retention is `phase_eight_retention_status` (it deletes nothing). A read that fails is refused, never rendered as an empty section:
 * someone who sees "nothing to do" must be seeing nothing to do.
 */

type Row = Record<string, unknown>;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Table = {
  select(columns: string): Table;
  eq(column: string, value: unknown): Table;
  order(column: string, options?: { ascending: boolean }): Table;
  limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

async function projectsDb(): Promise<{ rpc: Rpc; from: (t: string) => Table }> {
  const supabase = await createClient();
  const schema = supabase.schema('projects') as unknown as { rpc: Rpc; from: (t: string) => Table };
  return { rpc: (fn, args) => schema.rpc(fn, args), from: (t) => schema.from(t) };
}

// ── next actions ────────────────────────────────────────────────────────────────────────────────────────────

export type NextAction = {
  kind: string; rank: number; projectId: string | null; projectName: string | null; clientId: string; clientName: string; subjectId: string; detail: string; dueAt: string | null; designation: string | null;
};

export async function readNextActions(): Promise<NextAction[]> {
  const db = await projectsDb();
  const { data, error } = await db.rpc('cs_next_actions', {});
  if (error) unreadable('readNextActions', error);
  return rows(data).map((r) => ({
    kind: String(r.action_kind), rank: Number(r.rank), projectId: str(r.project_id), projectName: str(r.project_name), clientId: String(r.client_account_id), clientName: String(r.client_name),
    subjectId: String(r.subject_id), detail: String(r.detail ?? ''), dueAt: str(r.due_at), designation: str(r.designation),
  }));
}

// ── governance: denials and retention ───────────────────────────────────────────────────────────────────────

export type AccessDenial = { id: string; actorKind: string; surface: string; subjectId: string | null; reason: string; createdAt: string };

/** Admins only (the table's read policy); anyone else reads an empty list, which the page says plainly. */
export async function readAccessDenials(limit = 100): Promise<AccessDenial[]> {
  const db = await projectsDb();
  const { data, error } = await db.from('phase_eight_access_denials').select('id, actor_kind, surface, subject_id, reason, created_at').order('created_at', { ascending: false }).limit(limit);
  if (error) unreadable('readAccessDenials', error);
  return rows(data).map((r) => ({ id: String(r.id), actorKind: String(r.actor_kind), surface: String(r.surface), subjectId: str(r.subject_id), reason: String(r.reason), createdAt: String(r.created_at) }));
}

export type RetentionRow = { dataSet: string; recordClass: string | null; policySet: boolean; policyVersion: number | null; indefinite: boolean | null; retentionDays: number | null; rowsHeld: number; oldestAt: string | null };

export async function readRetentionStatus(): Promise<RetentionRow[]> {
  const db = await projectsDb();
  const { data, error } = await db.rpc('phase_eight_retention_status', {});
  if (error) unreadable('readRetentionStatus', error);
  return rows(data).map((r) => ({
    dataSet: String(r.data_set), recordClass: str(r.record_class), policySet: r.policy_set === true, policyVersion: typeof r.policy_version === 'number' ? r.policy_version : null,
    indefinite: typeof r.indefinite === 'boolean' ? r.indefinite : null, retentionDays: typeof r.retention_days === 'number' ? r.retention_days : null, rowsHeld: Number(r.rows_held ?? 0), oldestAt: str(r.oldest_at),
  }));
}

// ── knowledge base ──────────────────────────────────────────────────────────────────────────────────────────

export type KnowledgeArticle = {
  id: string; key: string; version: number; title: string; body: string; status: string; clientSafe: boolean; proposedByAgent: string | null; approvedAt: string | null; retireReason: string | null; createdAt: string;
};

export async function readKnowledgeArticles(): Promise<KnowledgeArticle[]> {
  const db = await projectsDb();
  const { data, error } = await db
    .from('support_knowledge_articles')
    .select('id, article_key, version, title, body, status, client_safe, proposed_by_agent, approved_at, retire_reason, created_at')
    .order('article_key', { ascending: true })
    .limit(500);
  if (error) unreadable('readKnowledgeArticles', error);
  return rows(data).map((r) => ({
    id: String(r.id), key: String(r.article_key), version: Number(r.version), title: String(r.title), body: String(r.body), status: String(r.status), clientSafe: r.client_safe === true,
    proposedByAgent: str(r.proposed_by_agent), approvedAt: str(r.approved_at), retireReason: str(r.retire_reason), createdAt: String(r.created_at),
  }));
}

// ── the client relationship (Customer 360 panel) ────────────────────────────────────────────────────────────

export type FeedbackRow = { id: string; kind: string; source: string; enteredBy: string; sentiment: string | null; rating: number | null; body: string; occurredOn: string; acknowledged: boolean };
export type DesignationRow = { id: string; designation: string; criteria: string; reason: string; active: boolean; setAt: string; endedReason: string | null };
export type PreferencesRow = { preferredChannel: string | null; language: string | null; avoidChannels: string[]; note: string | null; source: string; setAt: string };
export type CadenceRow = { id: string; purpose: string; channel: string | null; minGapDays: number; active: boolean };
export type Relationship = { feedback: FeedbackRow[]; designations: DesignationRow[]; preferences: PreferencesRow | null; cadence: CadenceRow[] };

export async function readRelationship(clientId: string): Promise<Relationship> {
  const db = await projectsDb();
  const [fb, acks, des, prefs, cad] = await Promise.all([
    db.from('client_feedback').select('id, kind, source, entered_by, sentiment, rating, body, occurred_on').eq('client_account_id', clientId).order('created_at', { ascending: false }).limit(50),
    db.from('client_feedback_acknowledgements').select('feedback_id').order('acknowledged_at', { ascending: false }).limit(500),
    db.from('client_strategic_designations').select('id, designation, criteria, reason, active, set_at, ended_reason').eq('client_account_id', clientId).order('set_at', { ascending: false }).limit(20),
    db.from('client_contact_preferences').select('preferred_channel, language, avoid_channels, note, source, set_at').eq('client_account_id', clientId).limit(1),
    db.from('communication_cadence_rules').select('id, purpose, channel, min_gap_days, active').order('purpose', { ascending: true }).limit(50),
  ]);
  if (fb.error) unreadable('readRelationship.feedback', fb.error);
  if (acks.error) unreadable('readRelationship.acknowledgements', acks.error);
  if (des.error) unreadable('readRelationship.designations', des.error);
  if (prefs.error) unreadable('readRelationship.preferences', prefs.error);
  if (cad.error) unreadable('readRelationship.cadence', cad.error);
  const acked = new Set(rows(acks.data).map((r) => String(r.feedback_id)));
  const p = rows(prefs.data)[0];
  return {
    feedback: rows(fb.data).map((r) => ({
      id: String(r.id), kind: String(r.kind), source: String(r.source), enteredBy: String(r.entered_by), sentiment: str(r.sentiment), rating: typeof r.rating === 'number' ? r.rating : null, body: String(r.body),
      occurredOn: String(r.occurred_on), acknowledged: acked.has(String(r.id)),
    })),
    designations: rows(des.data).map((r) => ({ id: String(r.id), designation: String(r.designation), criteria: String(r.criteria), reason: String(r.reason), active: r.active === true, setAt: String(r.set_at), endedReason: str(r.ended_reason) })),
    preferences: p
      ? { preferredChannel: str(p.preferred_channel), language: str(p.language), avoidChannels: Array.isArray(p.avoid_channels) ? (p.avoid_channels as string[]) : [], note: str(p.note), source: String(p.source), setAt: String(p.set_at) }
      : null,
    cadence: rows(cad.data).map((r) => ({ id: String(r.id), purpose: String(r.purpose), channel: str(r.channel), minGapDays: Number(r.min_gap_days), active: r.active === true })),
  };
}

export type Eligibility = { allowed: boolean; reasons: string[]; advisories: string[] };

/** The 8D eligibility read plus cadence and preferences. A failed read is refused: "allowed" must never be the default. */
export async function readEligibilityWithPreferences(clientId: string, channel: string, purpose: string): Promise<Eligibility | null> {
  const db = await projectsDb();
  const { data, error } = await db.rpc('can_contact_now_with_preferences', { p_client_account_id: clientId, p_channel: channel, p_purpose: purpose });
  if (error) unreadable('readEligibilityWithPreferences', error);
  const r = rows(data)[0];
  if (!r) return null;
  return { allowed: r.allowed === true, reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [], advisories: Array.isArray(r.advisories) ? (r.advisories as string[]) : [] };
}

// ── ticket-level: scope comparison and hand-off requests ────────────────────────────────────────────────────

export type ScopeReference = { id: string; relation: string; status: string; note: string; scopeItemTitle: string | null; scopeItemInclusion: string | null; proposedByAgent: string | null };

export async function readScopeComparison(ticketId: string): Promise<ScopeReference[]> {
  const db = await projectsDb();
  const { data, error } = await db.rpc('ticket_scope_comparison', { p_ticket_id: ticketId });
  if (error) unreadable('readScopeComparison', error);
  return rows(data).map((r) => ({
    id: String(r.reference_id), relation: String(r.relation), status: String(r.status), note: String(r.note), scopeItemTitle: str(r.scope_item_title), scopeItemInclusion: str(r.scope_item_inclusion), proposedByAgent: str(r.proposed_by_agent),
  }));
}

export type HandoffRequest = { id: string; ticketId: string; target: string; reason: string; status: string; requestedByAgent: string | null; requestedAt: string; resolutionNote: string | null };

export async function readHandoffRequests(ticketId: string): Promise<HandoffRequest[]> {
  const db = await projectsDb();
  const { data, error } = await db.from('support_handoff_requests').select('id, ticket_id, target, reason, status, requested_by_agent, requested_at, resolution_note').eq('ticket_id', ticketId).order('requested_at', { ascending: false }).limit(20);
  if (error) unreadable('readHandoffRequests', error);
  return rows(data).map((r) => ({
    id: String(r.id), ticketId: String(r.ticket_id), target: String(r.target), reason: String(r.reason), status: String(r.status), requestedByAgent: str(r.requested_by_agent), requestedAt: String(r.requested_at), resolutionNote: str(r.resolution_note),
  }));
}

// ── client portal ───────────────────────────────────────────────────────────────────────────────────────────

export type PortalFeedback = { id: string; kind: string; sentiment: string | null; rating: number | null; body: string; submittedAt: string; acknowledged: boolean };
export type PortalPreferences = { preferredChannel: string | null; language: string | null; avoidChannels: string[]; note: string | null };
export type PortalArticle = { key: string; title: string; body: string; version: number };

export async function readPortalFeedback(): Promise<PortalFeedback[]> {
  const db = await projectsDb();
  const { data, error } = await db.rpc('client_feedback_for_client', {});
  if (error) unreadable('readPortalFeedback', error);
  return rows(data).map((r) => ({ id: String(r.feedback_id), kind: String(r.kind), sentiment: str(r.sentiment), rating: typeof r.rating === 'number' ? r.rating : null, body: String(r.body), submittedAt: String(r.submitted_at), acknowledged: r.acknowledged === true }));
}

export async function readPortalPreferences(): Promise<PortalPreferences | null> {
  const db = await projectsDb();
  const { data, error } = await db.rpc('my_contact_preferences', {});
  if (error) unreadable('readPortalPreferences', error);
  const r = rows(data)[0];
  return r ? { preferredChannel: str(r.preferred_channel), language: str(r.language), avoidChannels: Array.isArray(r.avoid_channels) ? (r.avoid_channels as string[]) : [], note: str(r.note) } : null;
}

export async function readPortalArticles(): Promise<PortalArticle[]> {
  const db = await projectsDb();
  const { data, error } = await db.rpc('client_knowledge_articles', {});
  if (error) unreadable('readPortalArticles', error);
  return rows(data).map((r) => ({ key: String(r.article_key), title: String(r.title), body: String(r.body), version: Number(r.version) }));
}
