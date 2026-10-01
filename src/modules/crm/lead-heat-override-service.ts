import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { overrideLeadHeatSchema, type OverrideLeadHeatInput } from './lead-heat-override-schema';
import { readLeadHeatReading } from './lead-heat-queries';

/**
 * Q-OVERRIDE — the override door. Anyone who may write leads (`lead.write`) may
 * set the label with a reason; `crm.override_lead_heat` checks the role again,
 * keeps the computed label beside the override and audits every write. The
 * computed label is read here, from the same facts the page shows, and handed
 * to the door so the audit row records what was overruled.
 */
export async function overrideLeadHeat(input: OverrideLeadHeatInput): Promise<Result<{ outcome: 'overridden' | 'cleared' }>> {
  const parsed = overrideLeadHeatSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid override.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to change a lead’s heat.');

  const supabase = await createClient();
  const { data: lead, error: leadError } = await supabase.schema('crm').from('leads').select('id, status').eq('id', parsed.data.leadId).is('deleted_at', null).maybeSingle();
  if (leadError) {
    console.error(JSON.stringify({ level: 'error', scope: 'overrideLeadHeat', detail: leadError.message }));
    return err('INTERNAL', 'Could not read the lead.');
  }
  if (!lead) return err('NOT_FOUND', 'Lead not found.');

  // The computed label, never the displayed one: an override must not be recorded as overriding itself.
  const reading = await readLeadHeatReading({ id: lead.id, status: lead.status }, { ignoreOverride: true });

  const { data, error } = await supabase.schema('crm').rpc('override_lead_heat', {
    p_lead_id: parsed.data.leadId,
    p_label: parsed.data.label as string,
    p_reason: parsed.data.reason,
    p_computed: reading.label,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'overrideLeadHeat', detail: error.message }));
    return err('INTERNAL', 'Could not record the override.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'overridden':
      return ok({ outcome: 'overridden' });
    case 'cleared':
      return ok({ outcome: 'cleared' });
    case 'not_found':
      return err('NOT_FOUND', 'Lead not found.');
    case 'no_reason':
      return err('VALIDATION', 'Say why, in a sentence.');
    case 'bad_label':
      return err('VALIDATION', 'The label is Hot, Warm or Cold.');
    default:
      return err('FORBIDDEN', 'The database refused: you may not change a lead’s heat.');
  }
}
