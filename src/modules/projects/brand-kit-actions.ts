'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { addBrandRule, removeBrandRule } from './brand-kit-service';

export async function addBrandRuleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await addBrandRule({ projectId, title: String(formData.get('title') ?? ''), rule: String(formData.get('rule') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/design/brand`);
  return { status: 'success', message: 'Brand rule added.' };
}

export async function removeBrandRuleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await removeBrandRule({ projectId, ruleId: String(formData.get('ruleId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/design/brand`);
  return { status: 'success', message: 'Brand rule removed.' };
}
