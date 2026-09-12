import 'server-only';

import { z } from 'zod';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { OpportunityListItem, ProposalDetail, ProposalItem, ProposalListItem } from './types';

/** Reads for the sales module. Pure and RLS-scoped. */

const SELECT =
  'id, name, stage, currency, value_minor, lead_id, client_account_id, expected_close_on, created_at';

/** The opportunity for a lead, if one has been opened. */
export async function getOpportunityForLead(leadId: string): Promise<OpportunityListItem | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .select(SELECT)
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) unreadable('getOpportunityForLead', error);
  return data;
}

// ── quotations ─────────────────────────────────────────────────────────────

// One literal rather than a concatenation: supabase-js infers the row shape
// from the select string's *literal* type, and `a + b` widens it to `string`,
// at which point every column comes back as an error object.
const PROPOSAL_SELECT =
  'id, opportunity_id, version, title, status, currency, subtotal_minor, discount_minor, tax_minor, total_minor, valid_until, approval_request_id, sent_at, decided_at, created_at';

/**
 * Every version raised against a deal, newest first.
 *
 * The history Document 09 §16 asks for: superseded versions stay and are shown,
 * because "V1 remains historical" is only true if somebody can still read V1.
 */
export async function listProposalsForOpportunity(
  opportunityId: string,
): Promise<ProposalListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .from('proposals')
    .select(PROPOSAL_SELECT)
    .eq('opportunity_id', opportunityId)
    .order('version', { ascending: false });

  if (error) unreadable('listProposalsForOpportunity', error);
  return data ?? [];
}

/** The lines behind a quotation's total, in the order they are shown. */
export async function listProposalItems(proposalId: string): Promise<ProposalItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .from('proposal_items')
    .select('id, position, description, quantity, unit_price_minor, amount_minor')
    .eq('proposal_id', proposalId)
    .order('position', { ascending: true });

  if (error) unreadable('listProposalItems', error);
  return data ?? [];
}

/** One quotation and the lines behind its total. */
export async function getProposal(proposalId: string): Promise<ProposalDetail | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .from('proposals')
    // Also a literal, for the reason above: a template string widens too.
    .select(
      'id, opportunity_id, version, title, status, currency, subtotal_minor, discount_minor, tax_minor, total_minor, valid_until, approval_request_id, sent_at, decided_at, created_at, body',
    )
    .eq('id', proposalId)
    .maybeSingle();

  // `unreadable` throws, so nothing below it runs on a failed read: a null
  // from here always means the row is absent, never that the database did not
  // answer. Written as one expression rather than `if (!data) return null`,
  // which reads identically and matches the shape read-failure-semantics
  // forbids — a guard followed by a bare value return is exactly what G-054
  // removed, and the check does not care that this one is reached only when
  // there was no error.
  if (error) unreadable('getProposal', error);

  return data ? { ...data, items: await listProposalItems(proposalId) } : null;
}

export async function listOpportunities(limit = 100): Promise<OpportunityListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .select(SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listOpportunities', error);
  return data ?? [];
}

/** An open pushback, as the client said it — Doc 09 §19, read for the revision loop. */
export interface OpenObjection {
  id: string;
  round: number;
  kind: string;
  concern: string;
  created_at: string;
  proposal_id: string | null;
}

/**
 * The concerns nobody has answered yet, oldest first.
 *
 * Until G-157 these rows were read by exactly one thing — the sales agent's
 * own context file — so the person who has to draft the revised quotation
 * could not see what the client asked for without opening WhatsApp. §24's
 * loop starts from a person READING the ask; this is that read.
 */
export async function listOpenObjectionsForLead(leadId: string): Promise<OpenObjection[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .from('objections')
    .select('id, round, kind, concern, created_at, proposal_id')
    .eq('lead_id', leadId)
    .is('response', null)
    .order('created_at', { ascending: true });

  if (error) unreadable('listOpenObjectionsForLead', error);
  return data ?? [];
}

// ── The WON handoff packet (G-232 → a face, G-235) ─────────────────────────

import type { HandoffPacket } from './handoff-view';

/**
 * `sales.won_handoff_packet` strips every null, so every key is optional and
 * the schema says so. It validates shapes where a key is present and
 * refuses a body it does not recognise — a screen must not render a packet
 * it has misread as a packet it has read.
 */
const idObject = z.object({ id: z.string().optional(), name: z.string().optional(), stage: z.string().optional(), status: z.string().optional(), won_at: z.string().optional(), owner_id: z.string().optional(), budget_minor: z.number().optional(), currency: z.string().optional() }).partial();
const handoffPacketSchema = z
  .object({
    handoff_id: z.string(),
    status: z.string(),
    recorded_at: z.string(),
    correlation_id: z.string(),
    opportunity: idObject,
    project: idObject,
    project_deleted: z.boolean(),
    client: z.object({ client_account_id: z.string(), lead_id: z.string(), contact_id: z.string(), language: z.string(), whatsapp_consent: z.string() }).partial(),
    requirements: z.array(z.object({ requirement_version_id: z.string(), status: z.string() }).partial()),
    commercial: z.array(z.object({ kind: z.string(), proposal_id: z.string(), version: z.number(), total_minor: z.number(), currency: z.string(), sent_at: z.string(), sent_message_ref: z.string() }).partial()),
    decisions: z.array(z.object({ kind: z.string(), approval_id: z.string(), state: z.string(), decided_at: z.string(), decided_by: z.string(), approved_by_name: z.string(), approved_by_role: z.string(), proposal_id: z.string(), responded_by_contact_id: z.string(), has_note: z.boolean() }).partial()),
    constraints: z.array(z.object({
      kind: z.string(), requires_payment_evidence: z.string(), verdict_at_handoff: z.string(),
      evidence: z.object({ kind: z.string(), approval_id: z.string(), payment_id: z.string(), invoice_id: z.string(), amount_minor: z.number(), decided_at: z.string(), captured_at: z.string() }).partial(),
      objection_ids: z.array(z.string()),
    }).partial()),
    context: z.object({ conversation_id: z.string(), summary_through_seq: z.number() }).partial(),
    unresolved: z.array(z.string()),
  })
  .partial();

/**
 * The packet for one deal, or null when the deal was never handed off — or
 * is not this tenant's; the INVOKER projection reads under the caller's RLS
 * and does not say which. A body the schema does not recognise is thrown, not
 * rendered, and not returned as "no packet".
 */
export async function readWonHandoffPacket(opportunityId: string): Promise<HandoffPacket | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .rpc('won_handoff_packet', { p_opportunity_id: opportunityId });

  if (error) unreadable('readWonHandoffPacket', error);
  // No packet is the answer the projection gave; nothing is substituted for it.
  const body = data ?? null;
  if (body === null) return body;

  const parsed = handoffPacketSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`readWonHandoffPacket: the packet body was not recognised (${parsed.error.issues[0]?.path.join('.') ?? 'shape'})`);
  }
  return parsed.data;
}
