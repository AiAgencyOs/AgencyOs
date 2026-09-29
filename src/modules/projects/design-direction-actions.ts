'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { recordColorVariant, recordThemeDirection } from './design-direction-service';

/** SCR-033 — the Color studio's "record a direction" and "record a variant" controls. */

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '');
const opt = (formData: FormData, key: string) => str(formData, key).trim() || undefined;

function revalidateDesign(projectId: string) {
  revalidatePath(`/projects/${projectId}/design`);
  revalidatePath(`/projects/${projectId}/design/themes`);
  revalidatePath(`/projects/${projectId}/design/colors`);
}

export async function recordThemeDirectionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await recordThemeDirection({
    projectId,
    optionIndex: str(formData, 'optionIndex'),
    name: str(formData, 'name'),
    directionSummary: str(formData, 'directionSummary'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateDesign(projectId);
  return { status: 'success', message: 'Direction recorded beside the generated ones.' };
}

export async function recordColorVariantAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = str(formData, 'projectId');
  const result = await recordColorVariant({
    projectId,
    themeOptionId: str(formData, 'themeOptionId'),
    optionIndex: str(formData, 'optionIndex'),
    paletteName: str(formData, 'paletteName'),
    primaryHex: str(formData, 'primaryHex'),
    secondaryHex: opt(formData, 'secondaryHex'),
    accentHex: opt(formData, 'accentHex'),
    contrastNotes: opt(formData, 'contrastNotes'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateDesign(projectId);
  return { status: 'success', message: 'Colour variant recorded.' };
}
