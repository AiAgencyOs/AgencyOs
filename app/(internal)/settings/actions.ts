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

/**
 * The pricing model's own inputs — G-179.
 *
 * One action for all five, because they are one model: a day rate with no
 * multipliers produces nothing, and multipliers with no rate produce nothing
 * either. Saving them together means the owner either has a cost model or
 * does not, rather than a half-configured one that silently says nothing and
 * gives no clue why.
 *
 * The ORDER rule — minimum ≤ recommended ≤ premium — is checked here rather
 * than in the database, because `set_organization_setting` writes one key at
 * a time and cannot see the other four. Refusing the whole form is the right
 * shape: an owner raising all three passes through an incoherent moment on
 * the way, and the form is where that moment ends.
 */
export async function setPricingModelAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const field = (name: string) => String(formData.get(name) ?? '').trim();

  const min = field('multiplier_min');
  const target = field('multiplier_target');
  const max = field('multiplier_max');

  // Clearing is all-or-nothing for the same reason saving is: four of five
  // keys is a model that produces no figure and no explanation.
  const values = [field('day_rate'), field('ai_day_rate'), min, target, max];
  const filled = values.filter((v) => v !== '').length;
  if (filled !== 0 && filled !== values.length) {
    return {
      status: 'error',
      message: 'Fill in all five, or clear all five. A partly-configured model produces no figure at all.',
    };
  }

  if (filled === values.length) {
    const [lo, mid, hi] = [Number(min), Number(target), Number(max)];
    if (![lo, mid, hi].every(Number.isFinite) || !(lo <= mid && mid <= hi)) {
      return {
        status: 'error',
        message: 'The bands must rise: minimum ≤ recommended ≤ premium.',
      };
    }
  }

  const fields = [
    ['pricing_day_rate_rupees', 'day_rate'],
    ['pricing_ai_day_rate_rupees', 'ai_day_rate'],
    ['pricing_multiplier_min', 'multiplier_min'],
    ['pricing_multiplier_target', 'multiplier_target'],
    ['pricing_multiplier_max', 'multiplier_max'],
  ] as const;

  for (const [key, name] of fields) {
    const result = await setOrganizationSetting(key, field(name));
    if (!result.ok) return { status: 'error', message: result.error.message };
  }
  revalidatePath('/settings');
  return {
    status: 'success',
    message:
      filled === 0
        ? 'Pricing model cleared — quotations will show no cost bands.'
        : 'Pricing model saved. The owner sees these bands on a quotation priced below the minimum; a client never does.',
  };
}

/**
 * The fifth segment of a project group's name — G-188.
 *
 * The brief writes it in brackets — *[remaining configured identifier]* —
 * which is how an optional field is written, so an empty value clears it and
 * the name is composed with four segments instead of five.
 */
export async function setProjectGroupIdentifierAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const value = String(formData.get('project_group_identifier') ?? '').trim();
  const result = await setOrganizationSetting('project_group_identifier', value);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message: value
      ? 'Saved. New project groups will be named with it on the end.'
      : 'Cleared. Project group names will have four parts instead of five.',
  };
}

/**
 * The one concession the agent may apply without asking again — G-184, ADM-98.
 *
 * All four fields together, or all four cleared. A cap with no condition is a
 * discount the client never had to earn; a condition with no cap is not a
 * bound. The database refuses each value's own shape; this refuses the
 * combination, at the point a person can fix it.
 */
export async function setApprovedOfferAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { clearApprovedOffer, setApprovedOffer } = await import('@/modules/sales/service');
  const field = (name: string) => String(formData.get(name) ?? '').trim();

  const label = field('offer_label');
  const condition = field('offer_condition');
  const discount = field('offer_discount_pct');
  const validUntil = field('offer_valid_until');

  if (!label && !condition && !discount) {
    const cleared = await clearApprovedOffer();
    if (!cleared.ok) return { status: 'error', message: cleared.error.message };
    revalidatePath('/settings');
    return {
      status: 'success',
      message: cleared.data.cleared
        ? 'Offer withdrawn. The agent applies nothing from now on.'
        : 'There was no standing offer to withdraw.',
    };
  }

  if (!label || !condition || !discount) {
    return {
      status: 'error',
      message: 'Fill in all three, or clear all three. A cap with no condition is a discount nobody had to earn.',
    };
  }

  const pct = Number(discount);
  if (!Number.isInteger(pct) || pct < 1 || pct > 50) {
    return { status: 'error', message: 'The discount must be a whole number between 1 and 50.' };
  }

  const result = await setApprovedOffer({
    label,
    condition,
    discountPct: pct,
    validUntil: validUntil || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message:
      'Offer authorised. On a price objection the agent may apply it once per deal, without asking you again — and will tell you each time it does.',
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
