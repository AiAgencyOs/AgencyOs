import 'server-only';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { assignLeadSchema, type AssignLeadInput } from './assign-schema';

/**
 * Assigns a lead to a person, or clears the assignment.
 *
 * `lead.assign` is the capability the matrix already reserves for exactly
 * this (owner and ops_admin); RLS's `leads_write` decides again at the row.
 * The assignee must hold an ACTIVE membership of the caller's organization —
 * a lead handed to somebody who cannot open it is a lead nobody is looking
 * at, which is the state this door exists to end. Audited, because who owns
 * a conversation is the kind of fact somebody later asks about.
 */
export async function assignLead(input: AssignLeadInput): Promise<Result<{ assigneeId: string | null }>> {
  const parsed = assignLeadSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid assignment.');
  }

  const context = await requireInternal();
  if (!can(context, 'lead.assign')) {
    return err('FORBIDDEN', 'You do not have permission to assign leads.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  if (parsed.data.assigneeId) {
    const { data: membership, error: membershipError } = await supabase
      .schema('core')
      .from('memberships')
      .select('user_id, status')
      .eq('organization_id', context.organizationId)
      .eq('user_id', parsed.data.assigneeId)
      .maybeSingle();
    if (membershipError) return err('INTERNAL', 'Could not check that person’s membership.');
    if (!membership) return err('NOT_FOUND', 'That person is not a member of this organization.');
    if (membership.status !== 'active') return err('CONFLICT', 'That person’s membership is not active.');
  }

  const { data: lead, error: readError } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, assigned_to')
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();
  if (readError) return err('INTERNAL', 'Could not load the lead.');
  if (!lead) return err('NOT_FOUND', 'Lead not found.');

  const { data: updated, error: writeError } = await supabase
    .schema('crm')
    .from('leads')
    .update({ assigned_to: parsed.data.assigneeId })
    .eq('id', lead.id)
    .select('id')
    .maybeSingle();
  if (writeError) return err('INTERNAL', 'Could not assign the lead.');
  if (!updated) return err('FORBIDDEN', 'The database refused the assignment.');

  await recordAudit({
    organizationId: context.organizationId,
    action: 'lead.assigned',
    subjectType: 'lead',
    subjectId: lead.id,
    before: { assigned_to: lead.assigned_to },
    after: { assigned_to: parsed.data.assigneeId },
  });

  return ok({ assigneeId: parsed.data.assigneeId });
}
