import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { Json } from '@/lib/db/types';
import { err, ok, type Result } from '@/lib/result';

import { scoreLead, type LeadScore, type LeadScoreInputs } from './lead-score';
import { rescoreLeadSchema, type RescoreLeadInput } from './lead-score-schema';
import { leadQualificationSchema } from './schema';

/**
 * ADM-88 — Decision: reversed by the owner on 2026-09-29.
 *
 * The gathering half of a lead's score: every input `lead-score.ts` weighs
 * is a row the caller can already read (RLS decides), assembled here and
 * handed to the pure function. The result goes through `crm.set_lead_score`,
 * which refuses a score without its reasons and inputs and audits the write
 * as `lead.scored`. Gate: `lead.write`, the same capability the lead's other
 * edits use; RLS (`leads_write`) decides again on the row.
 */

type Db = Awaited<ReturnType<typeof createClient>>;

/** How many leads one "rescore all" walks — a bounded pass, not a queue. */
export const RESCORE_ALL_LIMIT = 300;

async function gatherInputs(
  supabase: Db,
  lead: { id: string; source: string; status: string; created_at: string; updated_at: string; qualification: Json },
  asOf: string,
): Promise<Result<LeadScoreInputs>> {
  const [coverage, conversations, opportunity] = await Promise.all([
    supabase.schema('crm').from('qualification_coverage').select('area').eq('lead_id', lead.id),
    supabase.schema('crm').from('conversations').select('id').eq('lead_id', lead.id),
    supabase
      .schema('sales')
      .from('opportunities')
      .select('stage, value_minor')
      .eq('lead_id', lead.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (coverage.error) return err('INTERNAL', 'Could not read the qualification coverage.');
  if (conversations.error) return err('INTERNAL', 'Could not read the conversations.');
  if (opportunity.error) return err('INTERNAL', 'Could not read the opportunity.');

  const conversationIds = (conversations.data ?? []).map((c) => c.id);
  let clientReplies = 0;
  if (conversationIds.length > 0) {
    const { count, error } = await supabase
      .schema('crm')
      .from('conversation_messages')
      .select('id', { count: 'exact', head: true })
      .in('conversation_id', conversationIds)
      .eq('author_type', 'client');
    if (error) return err('INTERNAL', 'Could not count the client’s replies.');
    clientReplies = count ?? 0;
  }

  const qualification = leadQualificationSchema.safeParse(lead.qualification ?? {});
  const q = qualification.success ? qualification.data : {};

  return ok({
    source: lead.source,
    status: lead.status,
    createdAt: lead.created_at,
    lastActivityAt: lead.updated_at,
    asOf,
    budgetMinor: q.budgetMinor ?? null,
    isDecisionMaker: q.isDecisionMaker ?? null,
    timelineNote: q.timelineNote ?? null,
    coveredAreas: [...new Set((coverage.data ?? []).map((c) => c.area))].sort(),
    clientReplies,
    dealValueMinor: opportunity.data?.value_minor ?? null,
    dealStage: opportunity.data?.stage ?? null,
  });
}

async function storeScore(supabase: Db, leadId: string, computed: LeadScore): Promise<Result<{ score: number }>> {
  const { data, error } = await supabase.schema('crm').rpc('set_lead_score', {
    p_lead_id: leadId,
    p_score: computed.score,
    p_reasons: computed.reasons as unknown as Json,
    p_inputs: computed.inputs as unknown as Json,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setLeadScore', detail: error.message }));
    return err('INTERNAL', 'Could not store the score.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'scored':
      return ok({ score: computed.score });
    case 'not_found':
      return err('NOT_FOUND', 'Lead not found.');
    case 'bad_score':
    case 'no_reasons':
    case 'no_inputs':
      return err('INTERNAL', `The database refused the score (${row.outcome}).`);
    default:
      return err('FORBIDDEN', 'You do not have permission to score leads.');
  }
}

const LEAD_SELECT = 'id, source, status, created_at, updated_at, qualification';

export async function rescoreLead(input: RescoreLeadInput): Promise<Result<{ score: number }>> {
  const parsed = rescoreLeadSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Not a lead.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to score leads.');

  const supabase = await createClient();
  const { data: lead, error } = await supabase
    .schema('crm')
    .from('leads')
    .select(LEAD_SELECT)
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return err('INTERNAL', 'Could not read the lead.');
  if (!lead) return err('NOT_FOUND', 'Lead not found.');

  const inputs = await gatherInputs(supabase, lead, new Date().toISOString());
  if (!inputs.ok) return inputs;

  return storeScore(supabase, lead.id, scoreLead(inputs.data));
}

/**
 * The rescore-all pass: every undeleted lead the caller can read, oldest
 * score first, bounded to RESCORE_ALL_LIMIT. Each lead is its own audited
 * write, so a refusal on one does not undo the others; the count of each is
 * what the caller is told.
 */
export async function rescoreAllLeads(): Promise<Result<{ scored: number; refused: number; considered: number }>> {
  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to score leads.');

  const supabase = await createClient();
  const { data: leads, error } = await supabase
    .schema('crm')
    .from('leads')
    .select(LEAD_SELECT)
    .is('deleted_at', null)
    .order('scored_at', { ascending: true, nullsFirst: true })
    .limit(RESCORE_ALL_LIMIT);
  if (error) return err('INTERNAL', 'Could not read the leads.');

  const asOf = new Date().toISOString();
  let scored = 0;
  let refused = 0;
  for (const lead of leads ?? []) {
    const inputs = await gatherInputs(supabase, lead, asOf);
    if (!inputs.ok) {
      refused += 1;
      continue;
    }
    const stored = await storeScore(supabase, lead.id, scoreLead(inputs.data));
    if (stored.ok) scored += 1;
    else refused += 1;
  }

  return ok({ scored, refused, considered: (leads ?? []).length });
}
