'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setGstIdentity } from './gst-identity-service';

/** Settings › Finance › GST identity — thin wrapper over gst-identity-service.ts. */
export async function setGstIdentityAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setGstIdentity({
    gstin: String(formData.get('gstin') ?? ''),
    stateCode: String(formData.get('stateCode') ?? ''),
    defaultSac: String(formData.get('defaultSac') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings/finance');
  revalidatePath('/finance/tax');
  const { gstin, stateCode, defaultSac } = result.data;
  return {
    status: 'success',
    message: gstin
      ? `Saved. The agency files as ${gstin} (state ${stateCode}), SAC ${defaultSac ?? 'not set'}. GSTR-1 and GSTR-3B can be exported from Finance › GST & tax${defaultSac ? '' : ' once a SAC is set'}.`
      : 'Saved with no GSTIN. The GSTR exports refuse until the agency’s own GSTIN is stated here.',
  };
}
