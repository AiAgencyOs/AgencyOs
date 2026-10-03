'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setAgentCaps, setAgentStatus } from './controls-service';

/** ADM-82 — Decision: reversed by the owner on 2026-09-29. The agent detail page's owner-only status and caps. */

export async function setAgentStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const agentKey = String(formData.get('agentKey') ?? '');
  const result = await setAgentStatus({
    agentKey,
    enabled: formData.get('enabled') === 'true',
    reason: String(formData.get('reason') ?? '').trim() || undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/agents/${agentKey}`);
  revalidatePath('/agents');
  return { status: 'success', message: result.data.enabled ? 'Agent enabled. Audited.' : 'Agent disabled, with the reason recorded. Audited.' };
}

export async function setAgentCapsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const agentKey = String(formData.get('agentKey') ?? '');
  const maxSteps = Number(formData.get('maxSteps'));
  const maxCostRupees = Number(formData.get('maxCostRupees'));
  const result = await setAgentCaps({
    agentKey,
    maxSteps: Number.isFinite(maxSteps) ? Math.trunc(maxSteps) : 0,
    maxCostMinor: Number.isFinite(maxCostRupees) ? Math.round(maxCostRupees * 100) : 0,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/agents/${agentKey}`);
  revalidatePath('/agents');
  return { status: 'success', message: `Ceilings set: ${result.data.maxSteps} steps, ₹${(result.data.maxCostMinor / 100).toFixed(2)} per run. Audited.` };
}
