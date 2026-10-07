'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * P604 forms: profile a functional case (scenario kind, layer, persona, environment, actual result, failure class, or NOT_APPLICABLE with its reason)
 * and record why a requirement has no direct functional test. Each calls a database DOOR as the signed-in person and reports the door's answer; the
 * doors own every rule (functional cases only, environments the plan lists, no secrets, a tested case is never not applicable).
 */

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const nothing = (v: string): string | null => (v === '' ? null : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Rpc = { schema(name: string): { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> } };

const WORDS: Record<string, string> = {
  not_authorized: 'You do not have permission to do that.',
  not_found: 'That record was not found.',
  not_a_functional_case: 'Only a functional case takes a functional profile.',
  plan_superseded: 'That plan has been superseded.',
  bad_scenario_kind: 'Choose one of the twelve scenario kinds.',
  bad_layer: 'Choose one of the eight layers.',
  bad_failure_class: 'Choose one of the seven failure classes.',
  failure_class_needs_a_failed_or_blocked_case: 'A failure class describes a failure: the case is neither failed nor blocked.',
  not_applicable_needs_a_reason: 'Not applicable needs a reason.',
  a_tested_case_is_applicable: 'A case that passed or failed was applicable.',
  environment_not_in_plan: 'The plan does not list that environment.',
  secret_in_text: 'Name the variable, never its value.',
  reason_required: 'Say why there is no direct functional test.',
  not_an_included_requirement: 'Only an included requirement of the baseline takes this.',
  has_a_direct_functional_case: 'That requirement already has a direct functional case.',
  already_recorded: 'Already recorded.',
};
const words = (outcome: string) => WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`;

async function callDoor(fn: string, args: Record<string, unknown>, success: string, projectId: string): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write') || !context.organizationId) return { status: 'error', message: 'You do not have permission to change this project.' };
  const supabase = (await createClient()) as unknown as Rpc;
  const { data, error } = await supabase.schema('qa').rpc(fn, args);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was changed.' };
  const row = ((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null) ?? null;
  const outcome = String(row?.outcome ?? 'no answer');
  if (outcome !== 'recorded') return { status: 'error', message: words(outcome) };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: success };
}

export async function recordFunctionalCaseProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const caseId = text(formData, 'caseId');
  if (!UUID.test(projectId) || !UUID.test(caseId)) return { status: 'error', message: 'That record was not found.' };
  return callDoor('record_functional_case_profile', {
    p_case_id: caseId, p_scenario_kind: text(formData, 'scenarioKind'), p_layer: text(formData, 'layer'), p_role: nothing(text(formData, 'role')),
    p_environment: nothing(text(formData, 'environment')), p_preconditions: nothing(text(formData, 'preconditions')), p_actual_result: nothing(text(formData, 'actualResult')),
    p_failure_class: nothing(text(formData, 'failureClass')), p_not_applicable_reason: nothing(text(formData, 'notApplicableReason')),
  }, 'Functional case profile recorded.', projectId);
}

export async function recordFunctionalExclusionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const planId = text(formData, 'planId');
  const scopeItemId = text(formData, 'scopeItemId');
  if (!UUID.test(projectId) || !UUID.test(planId) || !UUID.test(scopeItemId)) return { status: 'error', message: 'That record was not found.' };
  return callDoor('record_functional_exclusion', { p_plan_id: planId, p_scope_item_id: scopeItemId, p_reason: text(formData, 'reason') }, 'The reason is recorded; the requirement shows as excluded, not hidden.', projectId);
}
