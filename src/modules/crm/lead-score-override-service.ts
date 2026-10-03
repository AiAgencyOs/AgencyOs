import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { overrideLeadScoreSchema, type OverrideLeadScoreInput } from './lead-score-override-schema';

/**
 * SCR-008 — the override door. `lead.assign` is the capability: owner and
 * ops_admin, the two roles that decide who works a lead, and the database
 * (`core.is_admin()` inside `crm.override_lead_score`) says the same again.
 * The function refuses a lead that was never scored, so the computed score
 * is always there to be read beside the override, and audits every write.
 */
export async function overrideLeadScore(input: OverrideLeadScoreInput): Promise<Result<{ outcome: 'overridden' | 'cleared' }>> {
  const parsed = overrideLeadScoreSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid override.');

  const context = await requireInternal();
  if (!can(context, 'lead.assign')) return err('FORBIDDEN', 'Only the owner or an ops admin may override a lead score.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('override_lead_score', {
    p_lead_id: parsed.data.leadId,
    p_score: parsed.data.score,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'overrideLeadScore', detail: error.message }));
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
    case 'not_scored':
      return err('CONFLICT', 'This lead has no computed score yet. Score it first; an override sits beside the computed number, never in its place.');
    case 'no_reason':
      return err('VALIDATION', 'Say why, in a sentence.');
    case 'bad_score':
      return err('VALIDATION', 'The override is a whole number from 0 to 100.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may override a lead score.');
  }
}
