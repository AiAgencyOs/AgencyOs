'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { MODEL_CAPABILITIES } from './models-schema';
import { addModel, retireModel, setFallbackChain, setModelBudget, setProviderBudget } from './models-service';

/** SCR-064 — Decision 2026-09-30: ADM-84 reversed. The model registry's four owner doors, as forms. */

function optionalInt(raw: FormDataEntryValue | null): number | undefined {
  const text = String(raw ?? '').trim();
  if (text === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
}

/** Rupees as typed → minor units. */
function optionalRupeesToMinor(raw: FormDataEntryValue | null): number | undefined {
  const text = String(raw ?? '').trim();
  if (text === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
}

export async function addModelAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const capabilities = formData
    .getAll('capabilities')
    .map(String)
    .filter((c): c is (typeof MODEL_CAPABILITIES)[number] => (MODEL_CAPABILITIES as readonly string[]).includes(c));
  const result = await addModel({
    modelId: String(formData.get('modelId') ?? ''),
    provider: String(formData.get('provider') ?? '') as never,
    capabilities,
    contextTokens: optionalInt(formData.get('contextTokens')),
    inputCostMinorPerMtok: optionalRupeesToMinor(formData.get('inputCostRupeesPerMtok')),
    outputCostMinorPerMtok: optionalRupeesToMinor(formData.get('outputCostRupeesPerMtok')),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/agents/routing');
  revalidatePath('/agents');
  return {
    status: 'success',
    message: result.data.reactivated ? `${result.data.modelId} is available again. Audited.` : `${result.data.modelId} added to the registry. Audited.`,
  };
}

export async function retireModelAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await retireModel({
    modelId: String(formData.get('modelId') ?? ''),
    provider: String(formData.get('provider') ?? '') || undefined,
    reason: String(formData.get('reason') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/agents/routing');
  revalidatePath('/agents');
  return { status: 'success', message: `${result.data.modelId} retired, with the reason recorded. Audited.` };
}

export async function setFallbackChainAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const modelIds = String(formData.get('modelIds') ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const result = await setFallbackChain({
    workClass: String(formData.get('workClass') ?? '') as never,
    modelIds,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/agents/routing');
  return {
    status: 'success',
    message: result.data.cleared
      ? `No fallback chain for ${result.data.workClass} work — the runner goes straight to the agent's default. Audited.`
      : `Fallback chain for ${result.data.workClass} work saved (${modelIds.length} model${modelIds.length === 1 ? '' : 's'}). Audited.`,
  };
}

export async function setProviderBudgetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const rupees = Number(String(formData.get('monthlyCapRupees') ?? '0').trim() || '0');
  const result = await setProviderBudget({
    provider: String(formData.get('provider') ?? '') as never,
    monthlyCapMinor: Number.isFinite(rupees) ? Math.round(rupees * 100) : Number.NaN,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/agents/routing');
  revalidatePath('/usage');
  return {
    status: 'success',
    message: result.data.cleared
      ? `No monthly cap for ${result.data.provider}. Audited.`
      : `${result.data.provider} capped at ₹${rupees.toFixed(2)} a month — the runner refuses calls past it. Audited.`,
  };
}

export async function setModelBudgetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const rupees = Number(String(formData.get('monthlyCapRupees') ?? '0').trim() || '0');
  const result = await setModelBudget({
    modelId: String(formData.get('modelId') ?? ''),
    monthlyCapMinor: Number.isFinite(rupees) ? Math.round(rupees * 100) : Number.NaN,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/agents/routing');
  revalidatePath('/usage');
  return {
    status: 'success',
    message: result.data.cleared
      ? `No monthly cap for ${result.data.modelId}. Audited.`
      : `${result.data.modelId} capped at ₹${rupees.toFixed(2)} a month — the runner refuses calls past it. Audited.`,
  };
}
