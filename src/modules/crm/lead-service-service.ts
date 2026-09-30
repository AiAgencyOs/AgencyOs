import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { setLeadServiceSchema, type SetLeadServiceInput } from './lead-service-schema';

/**
 * The lead's service, replaced whole — `crm.leads.service` (SCR-006). Beside
 * `setLeadTags` in shape and gate: `lead.write`, then RLS decides again on
 * the row. A blank clears the column rather than storing an empty string,
 * so "no service recorded" stays one value. The row-change audit trigger on
 * crm.leads files the edit as `lead.updated`.
 */
export async function setLeadService(input: SetLeadServiceInput): Promise<Result<{ service: string | null }>> {
  const parsed = setLeadServiceSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'A service is at most 80 characters.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit leads.');
  }

  const service = parsed.data.service.length > 0 ? parsed.data.service : null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .update({ service })
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) return err('INTERNAL', 'Could not save the service.');
  if (!data) return err('NOT_FOUND', 'Lead not found.');

  return ok({ service });
}
