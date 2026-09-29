import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { setOpportunityOwnerSchema, type SetOpportunityOwnerInput } from './owner-schema';

/**
 * Hands a deal to a person — SCR-012.
 *
 * `sales.opportunities.owner_id` has been written once, at creation, by
 * whoever opened the deal, and never changed since. Gated on `lead.assign`:
 * the capability that exists for handing sales work to a person, and the
 * one the leads list's bulk assignment uses. The owner must be on this
 * organization's roster (`core.memberships`), so the select offers exactly
 * the ids the door accepts. A settled deal keeps its owner: the history of
 * who won or lost it is a fact, not a field.
 */
export async function setOpportunityOwner(
  input: SetOpportunityOwnerInput,
): Promise<Result<{ opportunityId: string; ownerId: string }>> {
  const parsed = setOpportunityOwnerSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Pick a person from the roster.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.assign')) {
    return err('FORBIDDEN', 'You do not have permission to assign deals.');
  }

  const supabase = await createClient();

  const { data: member, error: memberError } = await supabase
    .schema('core')
    .from('memberships')
    .select('user_id')
    .eq('user_id', parsed.data.ownerId)
    .limit(1)
    .maybeSingle();
  if (memberError) return err('INTERNAL', 'Could not check the roster.');
  if (!member) return err('NOT_FOUND', 'That person is not on this organization’s roster.');

  const { data: deal, error: readError } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id, stage, owner_id')
    .eq('id', parsed.data.opportunityId)
    .maybeSingle();
  if (readError) return err('INTERNAL', 'Could not load the deal.');
  if (!deal) return err('NOT_FOUND', 'Deal not found.');
  if (deal.stage === 'won' || deal.stage === 'lost') {
    return err('CONFLICT', `This deal is ${deal.stage}; its owner is part of the record now.`);
  }
  if (deal.owner_id === parsed.data.ownerId) return ok({ opportunityId: deal.id, ownerId: parsed.data.ownerId });

  const { data: moved, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .update({ owner_id: parsed.data.ownerId })
    .eq('id', deal.id)
    .eq('stage', deal.stage)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setOpportunityOwner', detail: error.message }));
    return err('INTERNAL', 'Could not change the owner.');
  }
  if (!moved) return err('CONFLICT', 'This deal changed while you were working. Reload and try again.');

  return ok({ opportunityId: deal.id, ownerId: parsed.data.ownerId });
}
