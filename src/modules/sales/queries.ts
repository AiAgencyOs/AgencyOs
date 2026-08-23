import 'server-only';

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
