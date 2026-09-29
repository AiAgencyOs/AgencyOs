import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { bulkLeadActionSchema, type BulkLeadActionInput, type BulkLeadOutcome } from './bulk-schema';
import { setLeadOwner, setLeadStatus, setLeadTags } from './service';

/**
 * The leads list's bulk loop — SCR-006.
 *
 * Nothing new is written here. Each selected lead goes through the SAME
 * single-row door the lead's own page uses (`setLeadOwner`, `setLeadStatus`,
 * `setLeadTags` in service.ts), which checks the capability, re-states the
 * row's state in its write and records the activity. The loop keeps every
 * refusal verbatim and does not stop at the first one: the person asked
 * about twenty leads and deserves twenty answers, and each door is its own
 * write, so a refusal on the ninth undoes nothing on the first eight —
 * which is what a list of outcomes says, honestly.
 */

/** Adds one tag to a lead, keeping the ones it has — the tag door takes the whole list. */
async function addLeadTag(leadId: string, tag: string): Promise<Result<{ tags: string[] }>> {
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
  const tags = [...new Set([...(lead.tags ?? []), tag])];
  return setLeadTags({ leadId, tags });
}

export async function bulkLeadAction(input: BulkLeadActionInput): Promise<Result<BulkLeadOutcome[]>> {
  const parsed = bulkLeadActionSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid bulk action.');

  // Re-checked here as well as in every door: a bulk request with nothing it
  // may do should be one refusal, not a hundred identical ones.
  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit leads.');
  }

  const outcomes: BulkLeadOutcome[] = [];
  const ids = [...new Set(parsed.data.leadIds)];

  for (const leadId of ids) {
    const result =
      parsed.data.kind === 'assign'
        ? await setLeadOwner({ leadId, assignedTo: parsed.data.ownerId })
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
        ? {
            leadId,
            ok: true,
            message:
              parsed.data.kind === 'assign'
                ? parsed.data.ownerId
                  ? 'Assigned.'
                  : 'Assignment cleared.'
                : parsed.data.kind === 'status'
                  ? `Moved to ${parsed.data.status}.`
                  : `Tagged “${parsed.data.tag}”.`,
          }
        : { leadId, ok: false, message: result.error.message },
    );
  }

  return ok(outcomes);
}
