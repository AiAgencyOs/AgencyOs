'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { linesOf, scopeItemsOf } from './requirement-revise-schema';
import { reviseRequirementVersion } from './requirement-revise-service';

/**
 * SCR-009 — the "Edit as new version" form on the Lead 360 requirement panel.
 * Builds the payload from the form's line-per-item fields and hands it to
 * the door; the refusal is shown as the door said it. The lead page is
 * revalidated from the lead id the DOOR returned, never from the form.
 */
export async function reviseRequirementVersionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '');

  const result = await reviseRequirementVersion({
    versionId: text('versionId'),
    payload: {
      summary: text('summary').trim(),
      scopeItems: scopeItemsOf(text('scopeItems')),
      constraints: linesOf(text('constraints')),
      openQuestions: linesOf(text('openQuestions')),
      assumptions: linesOf(text('assumptions')),
      niceToHaves: linesOf(text('niceToHaves')),
      exclusions: linesOf(text('exclusions')),
      designReferences: linesOf(text('designReferences')),
      // SCR-009 (bucket F-B) — the four fields the versioned requirement carries.
      userRoles: linesOf(text('userRoles')),
      platforms: linesOf(text('platforms')),
      integrations: linesOf(text('integrations')),
      timelineBudgetNotes: text('timelineBudgetNotes').trim(),
    },
  });

  if (!result.ok) return { status: 'error', message: result.error.message };
  const leadId = result.data.leadId ?? text('leadId');
  if (leadId) revalidatePath(`/leads/${leadId}`);
  return {
    status: 'success',
    message: `Written as v${result.data.version}, proposed — the version you edited is now superseded. Decide on the new one below.`,
  };
}
