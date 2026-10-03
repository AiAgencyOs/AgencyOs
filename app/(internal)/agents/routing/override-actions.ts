'use server';

import { revalidatePath } from 'next/cache';

import { setAgentRoutingOverride } from '@/lib/admin/agent-routing';
import type { FormState } from '@/modules/identity/types';

/** SCR-064 — set or clear one (agent, category) cell of the routing grid. Owner only; the door says so. */
export async function setAgentRoutingOverrideAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const clear = formData.get('intent') === 'clear';
  const raw = String(formData.get('preferredModels') ?? '').trim();

  const result = await setAgentRoutingOverride({
    agentKey: String(formData.get('agentKey') ?? ''),
    category: String(formData.get('category') ?? ''),
    preferredModels: clear || !raw ? [] : raw.split(',').map((m) => m.trim()).filter(Boolean),
    note: String(formData.get('note') ?? '').trim() || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/agents/routing');
  return {
    status: 'success',
    message:
      result.data.outcome === 'set'
        ? 'Override set. The runner consults it before the category policy.'
        : 'Override cleared — the category policy decides again.',
  };
}
