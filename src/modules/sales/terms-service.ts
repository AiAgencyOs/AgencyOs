import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { Json } from '@/lib/db/types';
import { err, ok, type Result } from '@/lib/result';

import { setProposalTermsSchema, type SetProposalTermsInput } from './terms-schema';

/**
 * SCR-012 — writes the edited commercial terms into a DRAFT quotation's
 * document. `proposal.draft`, the capability every other draft edit takes;
 * `proposals_write` decides again on the row and `proposals_guard` refuses
 * a document change on anything that has left draft, so the check here is
 * the same rule said earlier with a better sentence.
 */
export async function setProposalTerms(input: SetProposalTermsInput): Promise<Result<{ terms: string[] }>> {
  const parsed = setProposalTermsSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid terms.');

  const context = await requireInternal();
  if (!can(context, 'proposal.draft')) return err('FORBIDDEN', 'You do not have permission to draft quotations.');

  const supabase = await createClient();
  const { data: proposal, error } = await supabase.schema('sales').from('proposals').select('id, status, document').eq('id', parsed.data.proposalId).maybeSingle();
  if (error) return err('INTERNAL', 'Could not read the quotation.');
  if (!proposal) return err('NOT_FOUND', 'Quotation not found.');
  if (proposal.status !== 'draft') return err('CONFLICT', `This quotation is ${proposal.status}; its terms are frozen — draft the next version instead.`);

  const existing = proposal.document && typeof proposal.document === 'object' && !Array.isArray(proposal.document) ? (proposal.document as Record<string, Json>) : {};
  const document: Json = { ...existing, commercialTerms: parsed.data.terms.length > 0 ? parsed.data.terms : null };

  const { data: updated, error: writeError } = await supabase.schema('sales').from('proposals').update({ document }).eq('id', proposal.id).select('id').maybeSingle();
  if (writeError) {
    console.error(JSON.stringify({ level: 'error', scope: 'setProposalTerms', detail: writeError.message }));
    return err('INTERNAL', 'Could not save the terms.');
  }
  if (!updated) return err('FORBIDDEN', 'The database refused the change.');
  return ok({ terms: parsed.data.terms });
}
