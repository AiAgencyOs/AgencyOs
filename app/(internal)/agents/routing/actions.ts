'use server';

import { revalidatePath } from 'next/cache';

import { setRoutingPolicy } from '@/lib/admin/model-routing';
import type { FormState } from '@/modules/identity/types';

export async function setRoutingPolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const preferredModelsRaw = String(formData.get('preferredModels') ?? '').trim();
  const adminOverrideModel = String(formData.get('adminOverrideModel') ?? '').trim();

  const result = await setRoutingPolicy({
    category: String(formData.get('category') ?? '') as never,
    optimiseFor: String(formData.get('optimiseFor') ?? 'quality') as never,
    preferredModels: preferredModelsRaw
      ? preferredModelsRaw.split(',').map((m) => m.trim()).filter(Boolean)
      : [],
    ...(adminOverrideModel ? { adminOverrideModel } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/agents/routing');
  return { status: 'success', message: 'Saved.' };
}
