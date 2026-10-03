'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { validateAgentConfiguration } from './validation-service';

/** SCR-062 — "Validate now" on the agent detail page. The refusal is shown as written. */
export async function validateAgentConfigurationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const agentKey = String(formData.get('agentKey') ?? '');
  const result = await validateAgentConfiguration({ agentKey });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/agents/${agentKey}`);
  revalidatePath('/agents');

  const problems = result.data.findings.filter((f) => !f.ok).length;
  return {
    status: 'success',
    message:
      result.data.outcome === 'ok'
        ? `Validated against registry ${result.data.revision}: every check passed.`
        : `Validated against registry ${result.data.revision}: ${problems} problem${problems === 1 ? '' : 's'} recorded below.`,
  };
}
