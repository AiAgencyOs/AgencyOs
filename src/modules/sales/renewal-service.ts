import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { openRenewalSchema, type OpenRenewalInput } from './renewal-schema';

/**
 * SCR-016 — the renewal/upsell door. `lead.write`, the capability
 * `createOpportunity` takes for a new deal; `sales.open_renewal` checks the
 * session again, `opportunities_write` decides on the row, and the audit
 * row `opportunity.renewal_opened` names the project it continues from.
 */
export async function openRenewal(input: OpenRenewalInput): Promise<Result<{ opportunityId: string; leadId: string | null }>> {
  const parsed = openRenewalSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid renewal.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to open deals.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('sales').rpc('open_renewal', {
    p_client_account_id: parsed.data.clientAccountId,
    p_project_id: parsed.data.projectId,
    p_kind: parsed.data.kind,
    p_name: parsed.data.name,
    p_value_minor: parsed.data.valueMinor,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'openRenewal', detail: error.message }));
    return err('INTERNAL', 'Could not open the deal.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; opportunity_id?: string | null; lead_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'opened':
      if (!row.opportunity_id) return err('INTERNAL', 'Could not open the deal.');
      return ok({ opportunityId: row.opportunity_id, leadId: row.lead_id ?? null });
    case 'not_found':
      return err('NOT_FOUND', 'That project is not one of this client’s.');
    case 'not_completed':
      return err('CONFLICT', 'A renewal or upsell continues a COMPLETED project. This one is not completed yet.');
    case 'lead_busy':
      return err('CONFLICT', 'The lead this project was won on already has an open deal. Settle that one first — one open deal per lead.');
    case 'bad_kind':
    case 'no_name':
      return err('VALIDATION', 'Name the deal and say whether it is a renewal or an upsell.');
    default:
      return err('FORBIDDEN', 'You do not have permission to open deals.');
  }
}
