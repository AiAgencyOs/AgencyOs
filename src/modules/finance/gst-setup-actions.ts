'use server';

import { revalidatePath } from 'next/cache';

import { setOrganizationSetting } from '@/lib/admin/settings';
import type { FormState } from '@/modules/identity/types';

import { parseGstSetup } from './gst-settings';

/**
 * Settings › Finance › GST setup (owner decision 9, 2026-10-01). The three
 * values are validated here against the closed vocabulary and again by the
 * database whitelist; the door (`core.set_organization_setting`) re-checks the
 * role and audits each key with its old and new value.
 */
export async function setGstSetupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseGstSetup({
    registrationType: String(formData.get('registrationType') ?? ''),
    filingFrequency: String(formData.get('filingFrequency') ?? ''),
    periodBasis: String(formData.get('periodBasis') ?? ''),
  });
  if (!parsed.ok) return { status: 'error', message: parsed.message };

  for (const [key, value] of [
    ['gst_registration_type', parsed.value.registrationType],
    ['gst_filing_frequency', parsed.value.filingFrequency],
    ['gst_period_basis', parsed.value.periodBasis],
  ] as const) {
    const result = await setOrganizationSetting(key, value);
    if (!result.ok) return { status: 'error', message: result.error.message };
  }
  revalidatePath('/settings/finance');
  revalidatePath('/finance/tax');
  return { status: 'success', message: 'Saved. The tax page and the GSTR exports follow this setup.' };
}
