'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { rescoreAllLeads, rescoreLead } from './lead-score-service';

/** ADM-88 — Decision: reversed by the owner on 2026-09-29. The Lead 360 rescore and the list's rescore-all. */

export async function rescoreLeadAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const leadId = String(formData.get('leadId') ?? '');
  const result = await rescoreLead({ leadId });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/leads');
  return { status: 'success', message: `Scored ${result.data.score}/100, with the reasons and inputs recorded. Audited.` };
}

export async function rescoreAllLeadsAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const result = await rescoreAllLeads();
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/leads');
  const { scored, refused, considered } = result.data;
  return {
    status: refused > 0 ? 'error' : 'success',
    message:
      refused > 0
        ? `Scored ${scored} of ${considered} leads; ${refused} could not be scored.`
        : `Scored ${scored} lead${scored === 1 ? '' : 's'}. Every score carries its reasons and inputs. Audited.`,
  };
}
