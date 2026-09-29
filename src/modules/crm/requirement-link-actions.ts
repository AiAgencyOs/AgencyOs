'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { REQUIREMENT_LINK_TARGET_LABEL, type RequirementLinkTarget } from './requirement-link-schema';
import { linkRequirement } from './requirement-link-service';

/**
 * SCR-029 — the "Link…" form on the Lead 360 requirement panel. The target
 * type and id come from the pickers; the door decides whether the pair is
 * real. The refusal is shown as the door said it.
 */
export async function linkRequirementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '');
  const targetType = text('targetType') as RequirementLinkTarget;

  const result = await linkRequirement({
    versionId: text('versionId'),
    targetType,
    targetId: text('targetId'),
    note: text('note').trim() || undefined,
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  const leadId = text('leadId');
  if (leadId) revalidatePath(`/leads/${leadId}`);
  const label = REQUIREMENT_LINK_TARGET_LABEL[targetType] ?? 'Record';
  return { status: 'success', message: `${label} linked to this version.` };
}
