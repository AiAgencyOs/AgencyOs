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

/**
 * A whole import batch, in one bounded pass — G-219.
 *
 * The single-lead door above is the right shape for a lead's own page and the
 * wrong shape for twelve hundred people: a campaign against a batch is one
 * decision, and making an operator take it twelve hundred times is how the
 * eleven-hundredth gets taken without being read.
 *
 * Everything the database refuses, it refuses here too — the batch function
 * calls the single-lead one rather than repeating its rules, so consent and
 * G-210's relationship exclusion cannot be missing from the bulk path.
 */
export type BatchEnrolment = {
  enrolled: number;
  alreadyIn: number;
  noConsent: number;
  notContactable: number;
  uncommitted: number;
  remaining: number;
};

type BatchRow = {
  outcome: string;
  enrolled: number | null;
  already_in: number | null;
  no_consent: number | null;
  not_contactable: number | null;
  uncommitted: number | null;
  remaining: number | null;
};

export async function enrolReactivationBatch(
  batchId: string,
  limit = 100,
): Promise<Result<BatchEnrolment>> {
  const parsed = leadIdSchema.safeParse(batchId);
  if (!parsed.success) return err('VALIDATION', 'That is not a valid import batch id.');

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to enrol leads for reactivation.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('enrol_reactivation_batch', {
    p_batch_id: parsed.data,
    p_limit: limit,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'enrolReactivationBatch', detail: error.message }));
    return err('INTERNAL', 'The batch could not be enrolled.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as BatchRow | undefined;
  switch (row?.outcome) {
    case 'enrolled':
      return ok({
        enrolled: row.enrolled ?? 0,
        alreadyIn: row.already_in ?? 0,
        noConsent: row.no_consent ?? 0,
        notContactable: row.not_contactable ?? 0,
        uncommitted: row.uncommitted ?? 0,
        remaining: row.remaining ?? 0,
      });
    case 'pilot_off':
      // ADM-87's gate, reported as the deliberate thing it is rather than as
      // a failure: enrolling everybody into a campaign nobody has turned on
      // is how a campaign turns itself on.
      return err(
        'VALIDATION',
        'The reactivation pilot is switched off. Turn it on in Settings first — enrolling a batch into a campaign nobody has started is how one starts itself.',
      );
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner or ops-admin may enrol a batch.');
    case 'not_found':
      return err('NOT_FOUND', 'That import batch does not exist.');
    default:
      return err('INTERNAL', `The batch could not be enrolled (${row?.outcome ?? 'no answer'}).`);
  }
}

/** The way back out, in one action, whatever the gate says. */
export async function withdrawReactivationBatch(batchId: string): Promise<Result<{ withdrawn: number }>> {
  const parsed = leadIdSchema.safeParse(batchId);
  if (!parsed.success) return err('VALIDATION', 'That is not a valid import batch id.');

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to change the reactivation cohort.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('withdraw_reactivation_batch', {
    p_batch_id: parsed.data,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'withdrawReactivationBatch', detail: error.message }));
    return err('INTERNAL', 'The batch could not be withdrawn.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string; withdrawn: number | null } | undefined;
  switch (row?.outcome) {
    case 'withdrawn':
      return ok({ withdrawn: row.withdrawn ?? 0 });
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner or ops-admin may change the cohort.');
    case 'not_found':
      return err('NOT_FOUND', 'That import batch does not exist.');
    default:
      return err('INTERNAL', `The batch could not be withdrawn (${row?.outcome ?? 'no answer'}).`);
  }
}
