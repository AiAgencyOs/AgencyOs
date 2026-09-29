import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { checkGstin } from './gstin';
import { isGstStateCode } from './gst-states';
import { gstIdentitySchema, type GstIdentityInput } from './gst-identity-schema';

/**
 * Settings › Finance › GST identity — bucket E5. Owner only: a registration
 * number is the agency's legal identity on every return, not an
 * operational switch, so this is narrower than `organization.settings`
 * (owner + ops_admin). `core.set_gst_identity` checks is_owner again and
 * audits old and new in its own transaction; organizations_update (RLS)
 * decides a third time.
 */

type IdentityRow = { outcome: string };

export async function setGstIdentity(input: GstIdentityInput): Promise<Result<{ gstin: string | null; stateCode: string | null; defaultSac: string | null }>> {
  const parsed = gstIdentitySchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid GST identity.');

  const context = await requireInternal();
  if (context.role !== 'owner') {
    return err('FORBIDDEN', 'Only the owner can state the agency’s GST identity.');
  }
  if (!context.organizationId) return err('INTERNAL', 'No organization in your session.');

  let gstin = parsed.data.gstin;
  let stateCode = parsed.data.stateCode;
  if (gstin) {
    const verdict = checkGstin(gstin);
    if (!verdict.valid) return err('VALIDATION', `That cannot be a GSTIN: ${verdict.reason}.`);
    gstin = verdict.normalized;
    if (!stateCode) stateCode = verdict.stateCode;
    if (stateCode !== verdict.stateCode) {
      return err('VALIDATION', `The GSTIN begins with state ${verdict.stateCode}, but the state code given is ${stateCode}. They must agree.`);
    }
  }
  if (stateCode && !isGstStateCode(stateCode)) {
    return err('VALIDATION', `${stateCode} is not a state code the GSTN issues.`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('set_gst_identity', {
    p_organization_id: context.organizationId,
    p_gstin: gstin,
    p_state_code: stateCode,
    p_default_sac: parsed.data.defaultSac,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setGstIdentity', detail: error.message }));
    return err('INTERNAL', 'Could not save the GST identity.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as IdentityRow | undefined;
  if (!row) return err('INTERNAL', 'Could not save the GST identity.');

  switch (row.outcome) {
    case 'set':
      return ok({ gstin, stateCode, defaultSac: parsed.data.defaultSac });
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only the owner may set this.');
    case 'invalid_gstin':
      return err('VALIDATION', 'The database refused the GSTIN’s shape.');
    case 'invalid_state_code':
      return err('VALIDATION', 'A state code is two digits.');
    case 'state_mismatch':
      return err('VALIDATION', 'The GSTIN and the state code name different states.');
    case 'invalid_sac':
      return err('VALIDATION', 'A SAC/HSN code is 4 to 8 digits.');
    case 'not_found':
      return err('NOT_FOUND', 'Organization not found.');
    default:
      return err('INTERNAL', 'Could not save the GST identity.');
  }
}
