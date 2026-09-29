import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  bulkLeadActionSchema,
  setLeadOwnerSchema,
  setLeadTagsSchema,
  type BulkLeadActionInput,
  type BulkLeadOutcome,
  type SetLeadOwnerInput,
  type SetLeadTagsInput,
} from './bulk-schema';
import { setLeadStatus } from './service';

/**
 * The two single-row doors the leads list lacked, and the bulk loop over
 * all three — SCR-006.
 *
 * `setLeadOwner` is gated on `lead.assign`, the capability that exists for
 * exactly this and nothing else used; `setLeadTags` on `lead.write`, the
 * gate every other edit of a `crm.leads` row already passes. Both re-state
 * the row's current state in the write (`deleted_at is null`) so a lead
 * removed mid-selection is a NOT_FOUND sentence, not a silent no-op. Each
 * records a `lead_activities` row: `assignment` is one of the table's
 * thirteen kinds, and a tag is a `note` in the timeline's own vocabulary.
 *
 * The bulk loop calls the single-row door once per lead and keeps every
 * refusal verbatim. It does not stop at the first one: the person asked
 * about twenty leads and deserves twenty answers, and the doors are each
 * their own transaction so a refusal on the ninth undoes nothing on the
 * first eight — which is what a list of outcomes says, honestly.
 */
export async function setLeadOwner(input: SetLeadOwnerInput): Promise<Result<{ leadId: string }>> {
  const parsed = setLeadOwnerSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid assignment.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.assign')) {
    return err('FORBIDDEN', 'You do not have permission to assign leads.');
  }

  const supabase = await createClient();

  if (parsed.data.ownerId) {
    const { data: member, error: memberError } = await supabase
      .schema('core')
      .from('memberships')
      .select('user_id')
      .eq('user_id', parsed.data.ownerId)
      .limit(1)
      .maybeSingle();
    if (memberError) return err('INTERNAL', 'Could not check the roster.');
    if (!member) return err('NOT_FOUND', 'That person is not on this organization’s roster.');
  }

  const { data: lead, error: readError } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, organization_id, assigned_to')
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();
  if (readError) return err('INTERNAL', 'Could not load the lead.');
  if (!lead) return err('NOT_FOUND', 'Lead not found.');

  if (lead.assigned_to === parsed.data.ownerId) return ok({ leadId: lead.id });

  const { data: moved, error } = await supabase
    .schema('crm')
    .from('leads')
    .update({ assigned_to: parsed.data.ownerId })
    .eq('id', lead.id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setLeadOwner', detail: error.message }));
    return err('INTERNAL', 'Could not assign the lead.');
  }
  if (!moved) return err('CONFLICT', 'This lead changed while you were working. Reload and try again.');

  await supabase.schema('crm').from('lead_activities').insert({
    organization_id: lead.organization_id,
    lead_id: lead.id,
    kind: 'assignment',
    body: parsed.data.ownerId ? `Assigned to ${parsed.data.ownerId}` : 'Assignment cleared',
    actor_type: 'user',
    actor_id: context.userId,
    metadata: { from: lead.assigned_to, to: parsed.data.ownerId } as never,
  });

  return ok({ leadId: lead.id });
}

export async function setLeadTags(input: SetLeadTagsInput): Promise<Result<{ leadId: string; tags: string[] }>> {
  const parsed = setLeadTagsSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid tags.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit leads.');
  }

  const supabase = await createClient();
  const { data: lead, error: readError } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, organization_id, tags')
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();
  if (readError) return err('INTERNAL', 'Could not load the lead.');
  if (!lead) return err('NOT_FOUND', 'Lead not found.');

  const tags = [...new Set(parsed.data.tags.map((t) => t.toLowerCase()))];

  const { data: moved, error } = await supabase
    .schema('crm')
    .from('leads')
    .update({ tags })
    .eq('id', lead.id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setLeadTags', detail: error.message }));
    return err('INTERNAL', 'Could not update the tags.');
  }
  if (!moved) return err('CONFLICT', 'This lead changed while you were working. Reload and try again.');

  await supabase.schema('crm').from('lead_activities').insert({
    organization_id: lead.organization_id,
    lead_id: lead.id,
    kind: 'note',
    body: tags.length > 0 ? `Tags set: ${tags.join(', ')}` : 'Tags cleared',
    actor_type: 'user',
    actor_id: context.userId,
    metadata: { from: lead.tags, to: tags } as never,
  });

  return ok({ leadId: lead.id, tags });
}

/** Adds one tag to a lead, keeping the ones it has. */
async function addLeadTag(leadId: string, tag: string): Promise<Result<{ leadId: string; tags: string[] }>> {
  const supabase = await createClient();
  const { data: lead, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, tags')
    .eq('id', leadId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return err('INTERNAL', 'Could not load the lead.');
  if (!lead) return err('NOT_FOUND', 'Lead not found.');
  return setLeadTags({ leadId, tags: [...(lead.tags ?? []), tag] });
}

export async function bulkLeadAction(input: BulkLeadActionInput): Promise<Result<BulkLeadOutcome[]>> {
  const parsed = bulkLeadActionSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid bulk action.');

  // Re-checked here as well as in every door: a bulk request with nothing it
  // may do should be one refusal, not a hundred identical ones.
  const context = await requireInternal();
  const needed = parsed.data.kind === 'assign' ? 'lead.assign' : 'lead.write';
  if (!can(context.role, needed)) {
    return err('FORBIDDEN', `You do not have permission to ${parsed.data.kind === 'assign' ? 'assign' : 'edit'} leads.`);
  }

  const outcomes: BulkLeadOutcome[] = [];
  const ids = [...new Set(parsed.data.leadIds)];

  for (const leadId of ids) {
    const result =
      parsed.data.kind === 'assign'
        ? await setLeadOwner({ leadId, ownerId: parsed.data.ownerId })
        : parsed.data.kind === 'status'
          ? await setLeadStatus({
              leadId,
              status: parsed.data.status,
              reason: parsed.data.reason,
              nurtureReason: parsed.data.nurtureReason,
              nurtureUntil: parsed.data.nurtureUntil,
            })
          : await addLeadTag(leadId, parsed.data.tag);

    outcomes.push(
      result.ok
        ? { leadId, ok: true, message: parsed.data.kind === 'assign' ? (parsed.data.ownerId ? 'Assigned.' : 'Assignment cleared.') : parsed.data.kind === 'status' ? `Moved to ${parsed.data.status}.` : `Tagged “${parsed.data.tag}”.` }
        : { leadId, ok: false, message: result.error.message },
    );
  }

  return ok(outcomes);
}
