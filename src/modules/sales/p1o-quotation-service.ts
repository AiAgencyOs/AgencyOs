import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { asRows, firstRow, text, userRpc, whole } from '@/lib/db/p1o-rpc';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * Quotation Master gap closure, the application side (migration 20261127200000).
 *
 * Acceptance as evidence, cancellation, tax from configuration, readiness, the negotiation read and the per-quote timeline. Every refusal word the database
 * returns is turned into a sentence here; every read that fails is `unreadable`, never an empty list. No door in this file relaxes a human gate: the owner still
 * approves, a person still sends, and only a person records the client's acceptance.
 */

const SAY: Record<string, string> = {
  forbidden: 'Only an administrator of this organisation can do that.',
  needs_a_person: 'An acceptance is recorded by a person, with evidence; an agent cannot.',
  not_found: 'That quotation no longer exists.',
  bad_channel: 'Say where the acceptance came from: WhatsApp, email, a call, a meeting, the portal or other.',
  evidence_required: 'Evidence is required: the message reference, a recording, a signed reply. Without it the acceptance is only a claim.',
  client_identity_required: 'Name the client contact who accepted.',
  not_answerable: 'That quotation is not open with the client (it was not sent, or it is already answered).',
  version_mismatch: 'The client named a different version than this one. Open the version they named instead.',
  expired: 'That quotation expired before the client answered; it cannot be accepted. Draft a new version.',
  missing_reason: 'A reason is required.',
  already_cancelled: 'It is already cancelled.',
  not_cancellable: 'Only a draft, in-review, approved or sent quotation can be cancelled.',
  plan_set_member: 'A quotation inside a plan set is withdrawn by superseding the set.',
  missing_note: 'A note is required.',
  already_resolved: 'That is already resolved.',
  unknown_flag: 'That flag no longer exists.',
  unknown_clarification: 'That clarification no longer exists.',
  refused: 'The database refused those values.',
};

async function who(capability: 'proposal.send' | 'proposal.draft' | 'organization.settings'): Promise<Result<true>> {
  const context = await requireInternal();
  if (!can(context, capability)) return err('FORBIDDEN', 'Your role cannot do that.');
  return ok(true);
}

export type AcceptanceInput = {
  proposalId: string;
  contactId: string;
  channel: 'whatsapp' | 'email' | 'call' | 'meeting' | 'portal' | 'other';
  evidenceRef: string;
  statedVersion?: number | null;
  messageRef?: string | null;
  note?: string | null;
};

export type AcceptanceResult = { kind: 'recorded' } | { kind: 'needs_clarification'; clarificationId: string };

/** The evidenced acceptance. Several open versions and no stated version records a clarification and accepts nothing. */
export async function recordEvidencedAcceptance(input: AcceptanceInput): Promise<Result<AcceptanceResult>> {
  const gate = await who('proposal.send');
  if (!gate.ok) return gate;
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_record_acceptance', {
    p_proposal_id: input.proposalId,
    p_contact_id: input.contactId,
    p_channel: input.channel,
    p_evidence_ref: input.evidenceRef,
    p_stated_version: input.statedVersion ?? null,
    p_message_ref: input.messageRef ?? null,
    p_note: input.note ?? null,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordEvidencedAcceptance', detail: error.message }));
    return err('INTERNAL', 'Could not record the acceptance.');
  }
  const r = firstRow(data);
  const outcome = String(r?.outcome ?? '');
  if (outcome === 'recorded') return ok({ kind: 'recorded' });
  if (outcome === 'needs_clarification') return ok({ kind: 'needs_clarification', clarificationId: String(r?.clarification_id) });
  return err(outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}

export async function cancelQuotation(proposalId: string, reason: string): Promise<Result<string>> {
  const gate = await who('proposal.send');
  if (!gate.ok) return gate;
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_cancel_proposal', { p_proposal_id: proposalId, p_reason: reason });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'cancelQuotation', detail: error.message }));
    return err('INTERNAL', 'Could not cancel the quotation.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'cancelled' ? ok('Cancelled. Any pending approval was withdrawn; the history is kept.') : err(outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}

export type TaxApplication = { state: 'applied'; taxMinor: number; totalMinor: number } | { state: 'tax_uncertain' } | { state: 'not_draft' };

/** Compute the tax of a DRAFT from the configured mode and rate. With no configuration, or GST without a GSTIN, it raises a flag instead of guessing. */
export async function applyConfiguredTax(proposalId: string): Promise<Result<TaxApplication>> {
  const gate = await who('proposal.draft');
  if (!gate.ok) return gate;
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_apply_quote_tax', { p_proposal_id: proposalId });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'applyConfiguredTax', detail: error.message }));
    return err('INTERNAL', 'Could not apply the tax.');
  }
  const r = firstRow(data);
  switch (String(r?.outcome ?? '')) {
    case 'applied':
      return ok({ state: 'applied', taxMinor: whole(r?.tax_minor), totalMinor: whole(r?.total_minor) });
    case 'tax_uncertain':
      return ok({ state: 'tax_uncertain' });
    case 'not_draft':
      return ok({ state: 'not_draft' });
    case 'forbidden':
      return err('FORBIDDEN', SAY.forbidden as string);
    default:
      return err('NOT_FOUND', SAY.not_found as string);
  }
}

export type ReadinessCheck = { name: string; ok: boolean; detail: string };

export async function readQuoteReadiness(opportunityId: string): Promise<{ ready: boolean; checks: ReadinessCheck[] }> {
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_quote_readiness', { p_opportunity_id: opportunityId });
  if (error) unreadable('readQuoteReadiness', error);
  const checks = asRows(data).map((r) => ({ name: String(r.check_name), ok: r.ok === true, detail: String(r.detail) }));
  return { ready: checks.length > 0 && checks.every((c) => c.ok), checks };
}

export type NegotiationRound = {
  round: number; kind: string; concern: string; response: string | null; outcome: string | null; nextAction: string | null; at: string;
  proposalId: string | null; proposalVersion: number | null; proposalStatus: string | null; totalMinor: number | null; discountMinor: number | null; approvalState: string | null;
  discountDecisions: Array<{ id: string; discountMinor: number; pct: number; status: string; finalAmountMinor: number | null }>;
  clientResponses: Array<{ class: string; at: string; note: string | null }>;
};

export async function readNegotiationRounds(opportunityId: string): Promise<NegotiationRound[]> {
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_negotiation_rounds', { p_opportunity_id: opportunityId });
  if (error) unreadable('readNegotiationRounds', error);
  const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
  return asRows(data).map((r) => ({
    round: whole(r.round), kind: String(r.kind), concern: String(r.concern), response: text(r.response), outcome: text(r.outcome), nextAction: text(r.next_action), at: String(r.objection_at),
    proposalId: text(r.proposal_id), proposalVersion: r.proposal_version === null || r.proposal_version === undefined ? null : whole(r.proposal_version), proposalStatus: text(r.proposal_status),
    totalMinor: r.total_minor === null || r.total_minor === undefined ? null : whole(r.total_minor), discountMinor: r.discount_minor === null || r.discount_minor === undefined ? null : whole(r.discount_minor),
    approvalState: text(r.approval_state),
    discountDecisions: list(r.discount_decisions).map((d) => ({ id: String(d.id), discountMinor: whole(d.discountMinor), pct: Number(d.pct), status: String(d.status), finalAmountMinor: d.finalAmountMinor === null || d.finalAmountMinor === undefined ? null : whole(d.finalAmountMinor) })),
    clientResponses: list(r.client_responses).map((c) => ({ class: String(c.class), at: String(c.at), note: text(c.note) })),
  }));
}

export type QuoteTimelineEntry = { at: string; action: string; actorType: string; subjectType: string };

export async function readQuoteTimeline(proposalId: string): Promise<QuoteTimelineEntry[]> {
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_quote_timeline', { p_proposal_id: proposalId });
  if (error) unreadable('readQuoteTimeline', error);
  return asRows(data).map((r) => ({ at: String(r.occurred_at), action: String(r.action), actorType: String(r.actor_type), subjectType: String(r.subject_type) }));
}

export type VersionChange = { field: string; from?: unknown; to?: unknown; change?: string; description?: string };

export async function readVersionChangeSummary(proposalId: string): Promise<{ version: number; previousVersion: number | null; changes: VersionChange[] } | null> {
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_version_change_summary', { p_proposal_id: proposalId });
  if (error) unreadable('readVersionChangeSummary', error);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  return { version: whole(d.version), previousVersion: d.previousVersion === null ? null : whole(d.previousVersion), changes: Array.isArray(d.changes) ? (d.changes as VersionChange[]) : [] };
}

export type OpenClarification = { id: string; proposalIds: string[]; messageRef: string | null; raisedAt: string };

/** The questions an agent or person raised because a client said yes without saying which version. Resolved by an evidenced acceptance, or by hand with a note. */
export async function readOpenClarifications(opportunityId: string): Promise<OpenClarification[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('sales')
    .from('p1o_acceptance_clarifications' as never)
    .select('id, proposal_ids, message_ref, raised_at')
    .eq('opportunity_id', opportunityId)
    .eq('state', 'open');
  if (error) unreadable('readOpenClarifications', error);
  return asRows(data).map((r) => ({ id: String(r.id), proposalIds: Array.isArray(r.proposal_ids) ? (r.proposal_ids as string[]) : [], messageRef: text(r.message_ref), raisedAt: String(r.raised_at) }));
}

export async function resolveClarification(clarificationId: string, note: string): Promise<Result<string>> {
  const gate = await who('proposal.send');
  if (!gate.ok) return gate;
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_resolve_acceptance_clarification', { p_clarification_id: clarificationId, p_note: note });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'resolveClarification', detail: error.message }));
    return err('INTERNAL', 'Could not resolve that.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'resolved' ? ok('Resolved.') : err(outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}

export type QuotationPolicy = {
  tax: { mode: 'gst' | 'non_gst'; rateBp: number; updatedAt: string } | null;
  limits: { maxDiscountMinor: number | null; minAdvancePct: number | null; updatedAt: string } | null;
  gstRegistered: boolean;
  approvalPolicies: Array<{ minAmountMinor: number; requiredRole: string; slaHours: number }>;
  paymentStructures: Array<{ name: string; kind: string | null }>;
};

/** What a quotation is judged under right now: the same snapshot that is stamped onto a quote when it enters review. */
export async function readQuotationPolicy(organizationId: string): Promise<QuotationPolicy> {
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_policy_snapshot', { p_organization_id: organizationId });
  if (error) unreadable('readQuotationPolicy', error);
  const d = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const tax = d.tax as { mode?: string; rateBp?: number; updatedAt?: string } | null | undefined;
  const limits = d.limits as { maxDiscountMinor?: number | null; minAdvancePct?: number | null; updatedAt?: string } | null | undefined;
  const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
  return {
    tax: tax && (tax.mode === 'gst' || tax.mode === 'non_gst') ? { mode: tax.mode, rateBp: whole(tax.rateBp), updatedAt: String(tax.updatedAt) } : null,
    limits: limits ? { maxDiscountMinor: limits.maxDiscountMinor === null || limits.maxDiscountMinor === undefined ? null : whole(limits.maxDiscountMinor), minAdvancePct: limits.minAdvancePct === null || limits.minAdvancePct === undefined ? null : Number(limits.minAdvancePct), updatedAt: String(limits.updatedAt) } : null,
    gstRegistered: d.gstRegistered === true,
    approvalPolicies: list(d.approvalPolicies).map((a) => ({ minAmountMinor: whole(a.minAmountMinor), requiredRole: String(a.requiredRole), slaHours: whole(a.slaHours) })),
    paymentStructures: list(d.paymentStructures).map((s) => ({ name: String(s.name), kind: text(s.kind) })),
  };
}

export async function saveTaxConfig(input: { mode: 'gst' | 'non_gst'; rateBp: number; note: string | null }): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings') || !context.organizationId) return err('FORBIDDEN', 'Only an owner or ops admin can set the quotation tax configuration.');
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_set_quote_tax_config', { p_organization_id: context.organizationId, p_mode: input.mode, p_rate_bp: input.rateBp, p_note: input.note });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'saveTaxConfig', detail: error.message }));
    return err('INTERNAL', 'Could not save the tax configuration.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'set' ? ok('Saved. New quotations compute tax from this; existing ones keep the basis they were drafted with.') : err(outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', outcome === 'refused' ? 'GST needs a rate above zero; no-GST must be zero.' : (SAY[outcome] ?? 'The database refused that.'));
}

export async function saveNegotiationLimits(input: { maxDiscountMinor: number | null; minAdvancePct: number | null }): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings') || !context.organizationId) return err('FORBIDDEN', 'Only an owner or ops admin can set negotiation limits.');
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_set_negotiation_limits', { p_organization_id: context.organizationId, p_max_discount_minor: input.maxDiscountMinor, p_min_advance_pct: input.minAdvancePct });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'saveNegotiationLimits', detail: error.message }));
    return err('INTERNAL', 'Could not save the limits.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'set' ? ok('Saved. A quotation that breaches a limit is still decided by the owner, who is shown the breach.') : err(outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}

export type TaxFlag = { id: string; proposalId: string; note: string; raisedAt: string };

export async function listOpenTaxFlags(): Promise<TaxFlag[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('sales').from('p1o_quote_flags' as never).select('id, proposal_id, note, raised_at').eq('state', 'open').eq('kind', 'tax_uncertain').order('raised_at');
  if (error) unreadable('listOpenTaxFlags', error);
  return asRows(data).map((r) => ({ id: String(r.id), proposalId: String(r.proposal_id), note: String(r.note), raisedAt: String(r.raised_at) }));
}

export async function resolveTaxFlag(flagId: string, note: string): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'Only an owner or ops admin can resolve a tax question.');
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1o_resolve_quote_flag', { p_flag_id: flagId, p_note: note });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'resolveTaxFlag', detail: error.message }));
    return err('INTERNAL', 'Could not resolve that.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'resolved' ? ok('Resolved. The quotation can go for approval once its tax is applied.') : err(outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}
