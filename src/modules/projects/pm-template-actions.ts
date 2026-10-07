'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { decidePmTemplate, discardPmTemplateDraft, savePmTemplateDraft, submitPmTemplate, withdrawPmTemplate } from './pm-template-service';

/** The PM template editor's form actions (P2-PM-006). Each is a thin call to the service, which validates and then asks the database door. */

const text = (f: FormData, k: string) => String(f.get(k) ?? '');

function finish(result: { ok: true } | { ok: false; error: { message: string } }, message: string): FormState {
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/pm-templates');
  return { status: 'success', message };
}

export async function savePmTemplateDraftAction(_prev: FormState, f: FormData): Promise<FormState> {
  const result = await savePmTemplateDraft({ key: text(f, 'key'), language: text(f, 'language'), body: text(f, 'body') });
  return finish(result, result.ok ? `Draft saved as version ${result.data.version}. Submit it for review when it is ready.` : '');
}

export async function submitPmTemplateAction(_prev: FormState, f: FormData): Promise<FormState> {
  return finish(await submitPmTemplate(text(f, 'id')), 'Submitted for an Admin to review. It is not live yet.');
}

export async function withdrawPmTemplateAction(_prev: FormState, f: FormData): Promise<FormState> {
  return finish(await withdrawPmTemplate(text(f, 'id')), 'Taken back to draft.');
}

export async function discardPmTemplateDraftAction(_prev: FormState, f: FormData): Promise<FormState> {
  return finish(await discardPmTemplateDraft(text(f, 'id')), 'Draft discarded.');
}

export async function decidePmTemplateAction(_prev: FormState, f: FormData): Promise<FormState> {
  const decision = text(f, 'decision') === 'approve' ? 'approve' : 'reject';
  return finish(await decidePmTemplate(text(f, 'id'), decision, text(f, 'note')), decision === 'approve' ? 'Approved. The PM will use this wording from now on.' : 'Rejected, and kept with the reason.');
}
