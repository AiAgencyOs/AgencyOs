import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { interpretAddOutcome, interpretRemoveOutcome, type CohortDecision } from './reactivation-cohort-eval';

/**
 * Enrol a single lead in the reactivation cohort, or take it out — the "operate"
 * half of the reactivation pilot the Settings page points to ("Enrol leads from
 * a lead's own page"). Thin over the database, like the pilot toggle beside it
 * in `settings.ts`: the write, the authority, the consent rule and the audit all
 * live in `crm.add_lead_to_reactivation_pilot` / `remove_lead_from_reactivation_pilot`
 * (SECURITY DEFINER, owner/ops_admin, tenant derived from the lead row).
 *
 * Gated here on `organization.settings` — the same owner capability the pilot
 * toggle uses, so the whole reactivation control surface is owner-operated at
 * the app layer while the database independently admits owner OR ops_admin.
 * App stricter than the database is the safe direction and needs no new
 * capability (the finance rule: a capability mapping to an identical role set
 * adds vocabulary, not control).
 *
 * Consent is the database's to enforce and is NEVER manufactured here: enrolment
 * refuses `no_consent` unless the lead's contact holds a granted whatsapp
 * consent row, and this surfaces that refusal verbatim rather than working
 * around it. Removal has no consent check — taking a lead out is always safe.
 */

const leadIdSchema = z.string().uuid();

function outcomeOf(data: unknown): string | undefined {
  const r = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  return r?.outcome;
}

/** The one shape both enrol and remove share once authority and validation pass. */
function fromDecision<T>(decision: CohortDecision, success: T): Result<T> {
  if (decision.kind === 'error') return err(decision.code, decision.message);
  return ok(success);
}

export async function enrollLeadInReactivation(id: string): Promise<Result<{ enrolled: true }>> {
  const parsed = leadIdSchema.safeParse(id);
  if (!parsed.success) return err('VALIDATION', 'That is not a valid lead id.');

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to manage the reactivation cohort.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('add_lead_to_reactivation_pilot', {
    p_lead_id: parsed.data,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'enrollLeadInReactivation', detail: error.message }));
    return err('INTERNAL', 'Could not enrol the lead.');
  }

  return fromDecision(interpretAddOutcome(outcomeOf(data)), { enrolled: true });
}

export async function removeLeadFromReactivation(id: string): Promise<Result<{ enrolled: false }>> {
  const parsed = leadIdSchema.safeParse(id);
  if (!parsed.success) return err('VALIDATION', 'That is not a valid lead id.');

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to manage the reactivation cohort.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('remove_lead_from_reactivation_pilot', {
    p_lead_id: parsed.data,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'removeLeadFromReactivation', detail: error.message }));
    return err('INTERNAL', 'Could not remove the lead.');
  }

  return fromDecision(interpretRemoveOutcome(outcomeOf(data)), { enrolled: false });
}
