import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { asRows, firstRow, text, userRpc, whole } from '@/lib/db/p1o-rpc';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

import { estimateFor, recalculateTimeline, type TimelineVerdict } from './p1r-timeline-recalc';

/**
 * Round 4, Quotation Master, the application side of migration 20261203200000: per-line pricing, the delivery record, the invoices that bill a quotation, and the
 * recalculation of a timeline objection. Reads are database functions scoped to the caller's organisation; a read that fails is `unreadable`, never "none". Nothing
 * here sends anything, approves anything or accepts anything.
 */

const SAY: Record<string, string> = {
  forbidden: 'Only an administrator of this organisation can do that.',
  person_required: 'A signed-in person has to do that.',
  unknown_line: 'That line no longer exists.',
  not_a_draft: 'Only a draft quotation can be re-priced. Draft a new version instead.',
  bad_discount: 'A discount is zero or more.',
  bad_source: 'That is not a source kind the quotation knows.',
  missing_reason: 'A discount needs a reason: it is kept with the line.',
  discount_exceeds_line: 'A discount cannot be larger than the line it is taken from.',
  refused: 'The database refused those values.',
  unknown_objection: 'That objection no longer exists.',
  not_a_timeline_objection: 'Only a timeline objection is recalculated.',
};

export type QuoteLine = {
  lineId: string; position: number; description: string; quantity: number; unitPriceMinor: number; grossMinor: number; lineDiscountMinor: number; netMinor: number;
  sourceKind: string | null; catalogueRef: string | null; lineDiscountReason: string | null;
};

export async function readQuoteLines(proposalId: string): Promise<QuoteLine[]> {
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1r_quote_lines', { p_proposal_id: proposalId });
  if (error) unreadable('readQuoteLines', error);
  return asRows(data).map((r) => ({
    lineId: String(r.line_id), position: whole(r.line_position), description: String(r.description), quantity: Number(r.quantity), unitPriceMinor: whole(r.unit_price_minor),
    grossMinor: whole(r.gross_minor), lineDiscountMinor: whole(r.line_discount_minor), netMinor: whole(r.net_minor), sourceKind: text(r.source_kind), catalogueRef: text(r.catalogue_ref),
    lineDiscountReason: text(r.line_discount_reason),
  }));
}

export async function setLinePricing(input: { lineId: string; discountMinor: number; sourceKind: string | null; catalogueRef: string | null; reason: string | null }): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'proposal.draft')) return err('FORBIDDEN', 'Your role cannot draft quotations.');
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1r_set_line_pricing', {
    p_item_id: input.lineId, p_discount_minor: input.discountMinor, p_source_kind: input.sourceKind, p_catalogue_ref: input.catalogueRef, p_reason: input.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setLinePricing', detail: error.message }));
    return err('INTERNAL', 'Could not save that.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'set' ? ok('Saved. The line, the subtotal and the total follow.') : err(outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}

export type QuoteDelivery = { deliveredAt: string | null; viewedAt: string | null; failedAt: string | null };

export async function readQuoteDelivery(proposalId: string): Promise<QuoteDelivery | null> {
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1r_quote_delivery_for', { p_proposal_id: proposalId });
  if (error) unreadable('readQuoteDelivery', error);
  const r = firstRow(data);
  return r ? { deliveredAt: text(r.delivered_at), viewedAt: text(r.viewed_at), failedAt: text(r.failed_at) } : null;
}

export type BilledInvoice = { invoiceId: string; number: string; status: string; totalMinor: number; kind: string };

export async function readInvoicesForProposal(proposalId: string): Promise<BilledInvoice[]> {
  const rpc = await userRpc('finance');
  const { data, error } = await rpc('p1r_invoices_for_proposal', { p_proposal_id: proposalId });
  if (error) unreadable('readInvoicesForProposal', error);
  return asRows(data).map((r) => ({ invoiceId: String(r.invoice_id), number: String(r.invoice_number), status: String(r.invoice_status), totalMinor: whole(r.total_minor), kind: String(r.kind) }));
}

export type TimelineObjection = {
  objectionId: string; round: number; concern: string; proposalId: string | null;
  recalc: { askedWeeks: number; estimateMin: number; estimateMax: number; verdict: TimelineVerdict; options: string[]; recordedAt: string } | null;
};

export async function readTimelineObjections(opportunityId: string): Promise<TimelineObjection[]> {
  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1r_timeline_objections', { p_opportunity_id: opportunityId });
  if (error) unreadable('readTimelineObjections', error);
  return asRows(data).map((r) => ({
    objectionId: String(r.objection_id), round: whole(r.round), concern: String(r.concern), proposalId: text(r.proposal_id),
    recalc: r.recalc_id
      ? { askedWeeks: whole(r.asked_weeks), estimateMin: whole(r.estimate_min_weeks), estimateMax: whole(r.estimate_max_weeks), verdict: String(r.verdict) as TimelineVerdict,
          options: Array.isArray(r.options) ? (r.options as unknown[]).map(String) : [], recordedAt: String(r.recorded_at) }
      : null,
  }));
}

/**
 * Recalculate a timeline objection for the weeks the client asked, against the estimate the quotation carries (its stated timeline, else the corpus band for its price).
 * Records the result for the owner; changes no price and no quotation; sends nothing.
 */
export async function recalculateTimelineObjection(objectionId: string, askedWeeks: number): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'proposal.draft')) return err('FORBIDDEN', 'Your role cannot draft quotations.');
  if (!Number.isInteger(askedWeeks) || askedWeeks < 1 || askedWeeks > 104) return err('VALIDATION', 'Give the weeks the client asked for, as a whole number from 1 to 104.');

  const supabase = await createClient();
  const { data: objection, error: objectionError } = await supabase.schema('sales').from('objections').select('id, kind, proposal_id, lead_id').eq('id', objectionId).maybeSingle();
  if (objectionError) unreadable('recalculateTimelineObjection.objection', objectionError);
  if (!objection) return err('NOT_FOUND', SAY.unknown_objection as string);
  if (objection.kind !== 'timeline') return err('VALIDATION', SAY.not_a_timeline_objection as string);

  // The quotation the objection was about, else the lead's latest live one. A read that fails is an error, never "no quotation".
  let proposalId: string | null = objection.proposal_id;
  if (!proposalId) {
    const { data: opps, error: oppError } = await supabase.schema('sales').from('opportunities').select('id').eq('lead_id', objection.lead_id);
    if (oppError) unreadable('recalculateTimelineObjection.opportunities', oppError);
    const ids = (opps ?? []).map((o) => o.id);
    if (ids.length > 0) {
      const { data: latest, error: latestError } = await supabase.schema('sales').from('proposals').select('id').in('opportunity_id', ids).not('status', 'in', '("cancelled","superseded","rejected","lapsed")').order('created_at', { ascending: false }).limit(1);
      if (latestError) unreadable('recalculateTimelineObjection.proposals', latestError);
      proposalId = latest?.[0]?.id ?? null;
    }
  }
  if (!proposalId) return err('CONFLICT', 'There is no live quotation on this deal to measure the timeline against.');

  const { data: proposal, error: proposalError } = await supabase.schema('sales').from('proposals').select('id, total_minor, document').eq('id', proposalId).maybeSingle();
  if (proposalError) unreadable('recalculateTimelineObjection.proposal', proposalError);
  if (!proposal) return err('NOT_FOUND', 'That quotation no longer exists.');
  const document = (proposal.document ?? null) as { timelineWeeks?: { min?: unknown; max?: unknown } | null } | null;
  const result = recalculateTimeline({ askedWeeks, estimate: estimateFor(document?.timelineWeeks, proposal.total_minor) });

  const rpc = await userRpc('sales');
  const { data, error } = await rpc('p1r_record_timeline_recalc', {
    p_objection_id: objectionId, p_asked_weeks: result.askedWeeks, p_estimate_min: result.estimate.min, p_estimate_max: result.estimate.max, p_verdict: result.verdict,
    p_options: result.options, p_proposal_id: proposal.id,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recalculateTimelineObjection', detail: error.message }));
    return err('INTERNAL', 'Could not record the recalculation.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'recorded'
    ? ok(result.verdict === 'fits' ? 'Recorded: the estimate already fits.' : result.verdict === 'tight' ? 'Recorded: it fits only at the short end of the estimate.' : 'Recorded: it does not fit. The options are below for the owner.')
    : err(outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}
