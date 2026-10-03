import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  addModelSchema,
  retireModelSchema,
  setFallbackChainSchema,
  setModelBudgetSchema,
  setProviderBudgetSchema,
  type AddModelInput,
  type RetireModelInput,
  type SetFallbackChainInput,
  type SetModelBudgetInput,
  type SetProviderBudgetInput,
} from './models-schema';

/**
 * SCR-064 — Decision 2026-09-30: ADM-84 reversed, the owner manages models in
 * the panel. Four doors, each owner-only twice: `hasRole(context, 'owner')`
 * plus `organization.settings` here, and `core.is_owner()` again inside the
 * SECURITY DEFINER functions, which is the guard that holds because the plain
 * `models_write` policy was dropped with this decision. Every write audits.
 */
async function requireOwner(verb: string): Promise<Result<true>> {
  const context = await requireInternal();
  if (!hasRole(context, 'owner') || !can(context, 'organization.settings')) {
    return err('FORBIDDEN', `Only the owner may ${verb}.`);
  }
  return ok(true);
}

function outcomeOf(data: unknown): string | undefined {
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  return row?.outcome;
}

export async function addModel(input: AddModelInput): Promise<Result<{ modelId: string; reactivated: boolean }>> {
  const parsed = addModelSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid model.');

  const gate = await requireOwner('add a model to the registry');
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('add_model', {
    p_model_id: parsed.data.modelId,
    p_provider: parsed.data.provider,
    p_capabilities: parsed.data.capabilities,
    ...(parsed.data.contextTokens !== undefined ? { p_context_tokens: parsed.data.contextTokens } : {}),
    ...(parsed.data.inputCostMinorPerMtok !== undefined ? { p_input_cost_minor_per_mtok: parsed.data.inputCostMinorPerMtok } : {}),
    ...(parsed.data.outputCostMinorPerMtok !== undefined ? { p_output_cost_minor_per_mtok: parsed.data.outputCostMinorPerMtok } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addModel', detail: error.message }));
    return err('INTERNAL', 'Could not add the model.');
  }

  switch (outcomeOf(data)) {
    case 'added':
      return ok({ modelId: parsed.data.modelId, reactivated: false });
    case 'reactivated':
      return ok({ modelId: parsed.data.modelId, reactivated: true });
    case 'already_available':
      return err('CONFLICT', 'That model is already in the registry and available.');
    case 'bad_model':
      return err('VALIDATION', 'Not a model id an adapter would accept.');
    case 'bad_provider':
      return err('VALIDATION', 'Not a provider this system serves.');
    case 'bad_capabilities':
      return err('VALIDATION', 'A capability outside the five the registry knows.');
    default:
      return err('FORBIDDEN', 'Only the owner may add a model to the registry.');
  }
}

export async function retireModel(input: RetireModelInput): Promise<Result<{ modelId: string }>> {
  const parsed = retireModelSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const gate = await requireOwner('retire a model');
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('retire_model', {
    p_model_id: parsed.data.modelId,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'retireModel', detail: error.message }));
    return err('INTERNAL', 'Could not retire the model.');
  }

  switch (outcomeOf(data)) {
    case 'retired':
      return ok({ modelId: parsed.data.modelId });
    case 'not_found':
      return err('NOT_FOUND', 'That model is not in the registry.');
    case 'already_retired':
      return err('CONFLICT', 'That model is already retired.');
    case 'in_a_chain':
      return err('CONFLICT', 'A fallback chain still names that model — take it out of the chain first, then retire it.');
    case 'no_reason':
      return err('VALIDATION', 'Say why the model is being retired.');
    default:
      return err('FORBIDDEN', 'Only the owner may retire a model.');
  }
}

export async function setFallbackChain(input: SetFallbackChainInput): Promise<Result<{ workClass: string; cleared: boolean }>> {
  const parsed = setFallbackChainSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid chain.');

  const gate = await requireOwner('set a fallback chain');
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('set_fallback_chain', {
    p_work_class: parsed.data.workClass,
    p_model_ids: parsed.data.modelIds,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setFallbackChain', detail: error.message }));
    return err('INTERNAL', 'Could not save the fallback chain.');
  }

  switch (outcomeOf(data)) {
    case 'set':
      return ok({ workClass: parsed.data.workClass, cleared: false });
    case 'cleared':
      return ok({ workClass: parsed.data.workClass, cleared: true });
    case 'unknown_model':
      return err('VALIDATION', 'Every model in a chain must be an available row of the registry above — add it there first.');
    case 'too_many':
      return err('VALIDATION', 'At most ten models in a chain.');
    case 'bad_work_class':
      return err('VALIDATION', 'Not a work class this system recognises.');
    default:
      return err('FORBIDDEN', 'Only the owner may set a fallback chain.');
  }
}

export async function setProviderBudget(input: SetProviderBudgetInput): Promise<Result<{ provider: string; cleared: boolean }>> {
  const parsed = setProviderBudgetSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid budget.');

  const gate = await requireOwner('set a provider budget');
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('set_provider_budget', {
    p_provider: parsed.data.provider,
    p_monthly_cap_minor: parsed.data.monthlyCapMinor,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setProviderBudget', detail: error.message }));
    return err('INTERNAL', 'Could not save the provider budget.');
  }

  switch (outcomeOf(data)) {
    case 'set':
      return ok({ provider: parsed.data.provider, cleared: false });
    case 'cleared':
      return ok({ provider: parsed.data.provider, cleared: true });
    case 'unchanged':
      return err('CONFLICT', 'That is already the budget.');
    case 'bad_cap':
      return err('VALIDATION', 'The cap must be between ₹0 and ₹1,00,00,00,000.');
    case 'bad_provider':
      return err('VALIDATION', 'Not a provider this system serves.');
    default:
      return err('FORBIDDEN', 'Only the owner may set a provider budget.');
  }
}

export async function setModelBudget(input: SetModelBudgetInput): Promise<Result<{ modelId: string; cleared: boolean }>> {
  const parsed = setModelBudgetSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid budget.');

  const gate = await requireOwner('set a model budget');
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('set_model_budget', {
    p_model_id: parsed.data.modelId,
    p_monthly_cap_minor: parsed.data.monthlyCapMinor,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setModelBudget', detail: error.message }));
    return err('INTERNAL', 'Could not save the model budget.');
  }

  switch (outcomeOf(data)) {
    case 'set':
      return ok({ modelId: parsed.data.modelId, cleared: false });
    case 'cleared':
      return ok({ modelId: parsed.data.modelId, cleared: true });
    case 'unchanged':
      return err('CONFLICT', 'That is already the budget.');
    case 'bad_cap':
      return err('VALIDATION', 'The cap must be between ₹0 and ₹1,00,00,00,000.');
    case 'unknown_model':
      return err('VALIDATION', 'Only a model in the registry above can be given a budget — add it there first.');
    default:
      return err('FORBIDDEN', 'Only the owner may set a model budget.');
  }
}
