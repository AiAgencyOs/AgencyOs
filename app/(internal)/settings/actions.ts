'use server';

import { revalidatePath } from 'next/cache';

import { setAgencyTimezone, setOrganizationName, setOrganizationSetting, setReactivationPilot } from '@/lib/admin/settings';
import { verifyWhatsAppConfig } from '@/lib/admin/whatsapp-verify';
import type { FormState } from '@/modules/identity/types';

/**
 * Server Actions for the Settings screen. Thin, like the requeue action: they
 * know the route to revalidate and the shape a form expects; the write, the
 * capability check, and the database's final word all live in
 * `src/lib/admin/settings.ts`. Every refusal is surfaced as written.
 */

export async function setOrganizationNameAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setOrganizationName(String(formData.get('name') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message: `The agency is now "${result.data.name}" — every quotation PDF from here on carries it.`,
  };
}

export async function setTimezoneAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setAgencyTimezone(String(formData.get('timezone') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return { status: 'success', message: `Timezone set to ${result.data.timezone}. Follow-ups now schedule in this zone.` };
}

export async function setReactivationPilotAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const enabled = String(formData.get('enabled') ?? '') === 'true';
  const result = await setReactivationPilot(enabled);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message: result.data.enabled
      ? 'Reactivation pilot enabled — only enrolled, consented leads are nurtured.'
      : 'Reactivation pilot disabled — no reactivation sends.',
  };
}

export async function setWhatsAppNumberAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setOrganizationSetting('whatsapp_phone_number_id', String(formData.get('phone_number_id') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message: result.data.cleared
      ? 'WhatsApp phone number id cleared.'
      : 'WhatsApp phone number id saved. Verify the configuration to confirm it against Meta.',
  };
}

export async function setTestRecipientAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setOrganizationSetting('whatsapp_test_recipient', String(formData.get('test_recipient') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message: result.data.cleared
      ? 'Internal test recipient cleared.'
      : 'Internal test recipient saved — the safe number for a controlled first send.',
  };
}

/**
 * The contact block on the quotation PDF — G-171.
 *
 * One action for the three keys, because they are one block on the document
 * and a client who gets an email without a phone number is no better served
 * than one who gets neither. Each is cleared by an empty value, like every
 * other setting here.
 */
export async function setQuotationContactAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const fields = [
    ['quotation_contact_email', 'contact_email'],
    ['quotation_contact_phone', 'contact_phone'],
    ['quotation_contact_location', 'contact_location'],
  ] as const;

  for (const [key, field] of fields) {
    const result = await setOrganizationSetting(key, String(formData.get(field) ?? ''));
    if (!result.ok) return { status: 'error', message: result.error.message };
  }
  revalidatePath('/settings');
  return {
    status: 'success',
    message: 'Quotation contact details saved — they appear on every quotation PDF from now on.',
  };
}

export async function verifyWhatsAppAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const result = await verifyWhatsAppConfig();
  if (!result.ok) return { status: 'error', message: result.error.message };
  const r = result.data;
  if (!r.ok) return { status: 'error', message: r.message };
  const parts = [r.message];
  if (r.displayPhoneNumber) parts.push(`number ${r.displayPhoneNumber}`);
  if (r.verifiedName) parts.push(`“${r.verifiedName}”`);
  if (r.qualityRating) parts.push(`quality ${r.qualityRating}`);
  return { status: 'success', message: parts.join(' · ') };
}
