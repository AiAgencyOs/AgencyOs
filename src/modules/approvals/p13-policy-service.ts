import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { firstRow, looseSchema } from '@/lib/p13/loose-client';
import { err, ok, type Result } from '@/lib/result';

import { parsePolicyBody, POLICY_KINDS, type PolicyKind } from './p13-policy-model';

const REFUSAL: Record<string, string> = {
  not_authorized: 'Only an owner or ops admin may change policy.',
  no_actor: 'You are not signed in.',
  summary_required: 'Say in one line what this version changes.',
  reason_required: 'A reason is required to activate a version.',
  not_a_draft: 'Only a draft can be activated or discarded.',
  not_found: 'That version does not exist.',
  effective_in_the_past: 'An effective date cannot be in the past.',
  invalid_kind: 'Unknown policy kind.',
};

function refusal(outcome: string): Result<never> {
  if (outcome.startsWith('invalid_body')) return err('VALIDATION', `The database refused that policy: ${outcome.slice('invalid_body: '.length)}.`);
  return err(outcome === 'not_authorized' ? 'FORBIDDEN' : 'VALIDATION', REFUSAL[outcome] ?? 'The database refused the change.');
}

async function guard(): Promise<Result<null>> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to change policy.');
  return ok(null);
}

/** `core.p13_save_policy_draft`: one draft per kind; saving again edits it. Agents cannot reach this: it needs a signed-in admin. */
export async function savePolicyDraft(input: { kind: string; bodyText: string; summary: string; effectiveFrom?: string | null }): Promise<Result<{ version: number }>> {
  if (!POLICY_KINDS.includes(input.kind as PolicyKind)) return err('VALIDATION', 'Unknown policy kind.');
  const body = parsePolicyBody(input.bodyText);
  if (!body.ok) return err('VALIDATION', body.problem);
  const denied = await guard();
  if (!denied.ok) return denied;
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'core').rpc('p13_save_policy_draft', {
    p_kind: input.kind,
    p_body: body.body,
    p_summary: input.summary,
    p_effective_from: input.effectiveFrom || null,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'savePolicyDraft', detail: error.message }));
    return err('INTERNAL', 'Could not save the draft.');
  }
  const row = firstRow(data);
  if (row?.outcome !== 'saved') return refusal(String(row?.outcome ?? 'unknown'));
  return ok({ version: Number(row.version) });
}

export async function activatePolicyVersion(input: { id: string; reason: string }): Promise<Result<{ supersededId: string | null }>> {
  const denied = await guard();
  if (!denied.ok) return denied;
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'core').rpc('p13_activate_policy_version', { p_id: input.id, p_reason: input.reason });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'activatePolicyVersion', detail: error.message }));
    return err('INTERNAL', 'Could not activate the version.');
  }
  const row = firstRow(data);
  if (row?.outcome !== 'activated') return refusal(String(row?.outcome ?? 'unknown'));
  return ok({ supersededId: typeof row.superseded_id === 'string' ? row.superseded_id : null });
}

export async function discardPolicyDraft(id: string): Promise<Result<null>> {
  const denied = await guard();
  if (!denied.ok) return denied;
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'core').rpc('p13_discard_policy_draft', { p_id: id });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'discardPolicyDraft', detail: error.message }));
    return err('INTERNAL', 'Could not discard the draft.');
  }
  return data === 'discarded' ? ok(null) : refusal(String(data));
}
