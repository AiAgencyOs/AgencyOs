'use server';

import { revalidatePath } from 'next/cache';

import { WORK_CLASSES, type WorkClass } from '@/lib/ai/autonomy';
import type { FormState } from '@/modules/identity/types';

import { setAgentWorkClasses } from './work-classes-service';

/** SCR-063 — the agent detail page's owner-only "allowed work classes" form. */
export async function setAgentWorkClassesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const agentKey = String(formData.get('agentKey') ?? '');
  const workClasses = formData
    .getAll('workClasses')
    .map(String)
    .filter((w): w is WorkClass => (WORK_CLASSES as readonly string[]).includes(w));
  const result = await setAgentWorkClasses({ agentKey, workClasses });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/agents/${agentKey}`);
  revalidatePath('/agents');
  return {
    status: 'success',
    message:
      result.data.workClasses.length === 0
        ? 'No restriction — the agent may be handed every class of work its autonomy admits. Audited.'
        : `Allowed work: ${result.data.workClasses.map((w) => w.replace('_', ' ')).join(', ')}. The runner refuses anything else. Audited.`,
  };
}
