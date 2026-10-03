'use server';

import { PROBE_MODELS } from '@/lib/ai/providers';
import { resolveGoogleCalendar } from '@/lib/scheduling/google';
import { configuredProviders, resetProviderRegistry, resolveProvider } from '@/lib/ai/router';
import { deleteProviderCredential, setProviderCredential, VAULT_PROVIDERS, type VaultProvider } from '@/lib/ai/vault';
import { sendWhatsAppText } from '@/lib/whatsapp/send';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';

import { revalidatePath } from 'next/cache';

import { setAgencyTimezone, setDefaultDesignReviewer, setOrganizationName, setOrganizationSetting, setReactivationPilot,
  grantSecondaryRole,
  revokeSecondaryRole,
  setMembershipStatus,
  readOperationalSettings,
  recordPrivilegeReason,
  privilegeReasonIssue,
  settingText,
} from '@/lib/admin/settings';
import { verifyWhatsAppConfig } from '@/lib/admin/whatsapp-verify';
import type { FormState } from '@/modules/identity/types';
import { publishQuotationClause } from '@/modules/sales/clauses-service';
import { CLAUSE_LABELS, isClauseKey } from '@/modules/sales/quotation-clauses';

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

/**
 * The most reactivation follow-ups one worker run will send — G-223.
 *
 * G-216 bounds what the agency starts over a day; this bounds a single tick, so
 * switching the pilot on for a large enrolled cohort does not send the whole
 * batch at once. Empty clears the ceiling. Validated here to the same 1–500 the
 * database enforces, so a bad value comes back as a sentence rather than as
 * `invalid_value`.
 */
export async function setReactivationCapAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = String(formData.get('max_per_run') ?? '').trim();
  if (raw !== '') {
    const parsed = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      return { status: 'error', message: 'The per-run cap must be a whole number between 1 and 500.' };
    }
  }
  const result = await setOrganizationSetting('reactivation_max_per_run', raw);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message:
      raw === ''
        ? 'Per-run cap cleared — reactivation sends are bounded only by the daily outreach limits.'
        : `Per-run cap set to ${raw}. At most ${raw} reactivation follow-ups go out per worker run; the rest wait for the next.`,
  };
}

/**
 * How quickly the agent answers — G-209.
 *
 * Off by default and off in every deployment until somebody turns it on: a
 * capability that changes how every inbound message is handled should be a
 * decision, not something a deploy hands you.
 */
export async function setWakeRunnerOnInboundAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { setWakeRunnerOnInbound } = await import('@/lib/admin/settings');
  const enabled = String(formData.get('enabled') ?? '') === 'true';
  const result = await setWakeRunnerOnInbound(enabled);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message: result.data.enabled
      ? 'The agent now answers as soon as a message arrives, instead of waiting for the next minute.'
      : 'The agent waits for the scheduled run again — up to a minute before it starts.',
  };
}

/**
 * Registering the template that answers a situation — G-213.
 *
 * An empty template name WITHDRAWS, the same gesture the payment-terms and
 * third-party-charge forms use: somebody clearing a row should not have to
 * find a second control to do it with.
 */
export async function setOutreachLimitsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { setOutreachLimits } = await import('@/lib/admin/settings');
  const number = (n: string) => Number(String(formData.get(n) ?? '').trim());

  const limits = {
    perContactPerDay: number('per_contact_per_day'),
    perContactPerWeek: number('per_contact_per_week'),
    perOrganizationPerDay: number('per_organization_per_day'),
    unansweredBeforeCooldown: number('unanswered_before_cooldown'),
    cooldownDays: number('cooldown_days'),
  };

  if (Object.values(limits).some((v) => !Number.isInteger(v) || v < 0)) {
    return { status: 'error', message: 'Each limit is a whole number, and none of them can be negative.' };
  }

  const result = await setOutreachLimits(limits);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return { status: 'success', message: 'Saved. These apply to every message AgencyOS starts from now on.' };
}

export async function setWhatsAppTemplateStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { setWhatsAppTemplateStatus } = await import('@/lib/admin/settings');
  const field = (n: string) => String(formData.get(n) ?? '').trim();

  const situation = field('template_situation') as Parameters<typeof setWhatsAppTemplateStatus>[0]['situationKey'];
  const status = field('template_status') as Parameters<typeof setWhatsAppTemplateStatus>[0]['status'];
  if (!situation || !status) return { status: 'error', message: 'Choose a situation and a status.' };

  const result = await setWhatsAppTemplateStatus({ situationKey: situation, status });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message:
      status === 'approved'
        ? 'Recorded. This template can be delivered outside the 24-hour window.'
        : `Recorded as ${status}. Nothing sends from it until Meta approves it again.`,
  };
}

export async function setWhatsAppTemplateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { setWhatsAppTemplate, clearWhatsAppTemplate } = await import('@/lib/admin/settings');
  const field = (n: string) => String(formData.get(n) ?? '').trim();

  const situation = field('template_situation') as Parameters<typeof setWhatsAppTemplate>[0]['situationKey'];
  if (!situation) return { status: 'error', message: 'Choose which situation this template answers.' };

  const name = field('template_name');
  if (!name) {
    // The language, when the form named one: with two registered, a
    // withdrawal that names none is refused rather than guessing which
    // message a client stops receiving.
    const cleared = await clearWhatsAppTemplate(situation, field('template_language') || undefined);
    if (!cleared.ok) return { status: 'error', message: cleared.error.message };
    revalidatePath('/settings');
    return {
      status: 'success',
      message:
        'Template withdrawn. Anyone it answered for now falls back to another language, or to nothing outside the 24-hour window.',
    };
  }

  const parameters = field('template_parameters')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const result = await setWhatsAppTemplate({
    situationKey: situation,
    templateName: name,
    languageCode: field('template_language') || 'en',
    parameters,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message: 'Template registered. Follow-ups outside the 24-hour window will use it.',
  };
}

export async function setWhatsAppNumberAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setOrganizationSetting('whatsapp_phone_number_id', String(formData.get('phone_number_id') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  // SCR-070 — the same form is mounted on the integration's own row.
  revalidatePath('/integrations');
  return {
    status: 'success',
    message: result.data.cleared
      ? 'WhatsApp phone number id cleared.'
      : 'WhatsApp phone number id saved. Verify the configuration to confirm it against Meta.',
  };
}

/**
 * O-6 — what the sales agent may say about the agency. Statements the owner has
 * approved, one per line; they reach clients, so this goes through the one
 * settings door (owner / ops admin, whitelisted, validated, audited). Clearing
 * it returns the agent to saying nothing about the agency beyond "a colleague
 * will confirm".
 */
export async function setTrustFactsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setOrganizationSetting('approved_trust_facts', String(formData.get('trust_facts') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/communication');
  return {
    status: 'success',
    message: result.data.cleared
      ? 'Cleared. The agent will say nothing about the agency beyond “a colleague will confirm”.'
      : 'Saved. The agent may now say these, in its own words, and nothing beyond them.',
  };
}

/** Q-D1 — the Google Calendar id, through the one settings door (owner / ops admin, whitelisted, validated, audited with old and new). */
export async function setCalendarIdAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setOrganizationSetting('google_calendar_id', String(formData.get('calendar_id') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/integrations');
  revalidatePath('/meetings');
  return {
    status: 'success',
    message: result.data.cleared
      ? 'Calendar id cleared. The GOOGLE_CALENDAR_ID environment value, if there is one, is used again.'
      : 'Calendar id saved. It is read before the environment value; verify the calendar to confirm Google can read it.',
  };
}

export async function setTestRecipientAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setOrganizationSetting('whatsapp_test_recipient', String(formData.get('test_recipient') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  revalidatePath('/integrations');
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
 * The agency's own payment terms — G-196, Doc 07 §11.
 *
 * Up to eight milestones, given as pairs of a label and a percentage, saved
 * whole. Configure nothing and every quotation keeps the two schedules
 * forty-five real quotations actually used — which is why the empty form
 * CLEARS rather than errors: "no configured terms" is a valid, common and
 * previously universal state.
 */
export async function setPaymentTermsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { setPaymentStructure, clearPaymentStructure } = await import('@/modules/sales/service');
  const field = (name: string) => String(formData.get(name) ?? '').trim();

  const name = field('terms_name') || 'Standard';
  const milestones: Array<{ label: string; pct: number }> = [];
  for (let i = 0; i < 8; i += 1) {
    const label = field(`milestone_label_${i}`);
    const pct = field(`milestone_pct_${i}`);
    if (!label && !pct) continue;
    if (!label || !pct) {
      return { status: 'error', message: `Milestone ${i + 1} needs both a name and a percentage.` };
    }
    const parsed = Number(pct);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
      return { status: 'error', message: `Milestone ${i + 1}'s percentage must be above 0 and at most 100.` };
    }
    milestones.push({ label, pct: parsed });
  }

  if (milestones.length === 0) {
    const cleared = await clearPaymentStructure(name);
    if (!cleared.ok) return { status: 'error', message: cleared.error.message };
    revalidatePath('/settings');
    return {
      status: 'success',
      message: cleared.data.cleared
        ? 'Payment terms cleared. Quotations go back to the two standard schedules.'
        : 'There were no configured terms to clear.',
    };
  }

  // Checked here as well as in the database so the person reading the form is
  // told the total rather than handed a constraint violation — and checked in
  // the database as well as here because this form is not the only door.
  const total = milestones.reduce((sum, m) => sum + m.pct, 0);
  if (Math.abs(total - 100) > 0.001) {
    return { status: 'error', message: `The milestones add up to ${total}%. They must add up to exactly 100%.` };
  }

  const min = field('terms_min_rupees');
  const max = field('terms_max_rupees');
  for (const [raw, which] of [[min, 'lower'], [max, 'upper']] as const) {
    if (raw !== '' && !/^[0-9]+$/.test(raw)) {
      return { status: 'error', message: `The ${which} amount must be whole rupees, digits only.` };
    }
  }

  const result = await setPaymentStructure({
    name,
    milestones,
    minAmountMinor: min === '' ? null : Number(min) * 100,
    maxAmountMinor: max === '' ? null : Number(max) * 100,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message:
      'Payment terms saved. New quotations in this amount range carry them; ones already drafted keep the terms they were drafted with.',
  };
}

/**
 * Doc §21's negotiation limits — G-195.
 *
 * Four independent fields, and independent is the point: unlike the pricing
 * model, which produces no figure at all unless all five are set, each of
 * these bounds a different act and any one of them is worth having on its
 * own. So each is saved or cleared on its own, and an empty box means "no
 * limit" rather than "not finished".
 *
 * The database validates every shape and owns the whitelist; this checks the
 * two things a person can see and fix here — that a number is a number, and
 * that it is in the range the database will accept — so the answer comes back
 * as a sentence rather than as `invalid_value`.
 */
export async function setNegotiationLimitsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const field = (name: string) => String(formData.get(name) ?? '').trim();

  const fields = [
    ['negotiation_max_rounds', 'max_rounds', 1, 20, 'Rounds must be a whole number between 1 and 20.'],
    ['negotiation_min_price_rupees', 'min_price', 1, 99_999_999, 'The minimum price must be whole rupees, digits only.'],
    ['negotiation_max_discount_pct', 'max_discount', 1, 50, 'The maximum discount must be a whole percentage between 1 and 50.'],
    [
      'negotiation_max_autonomous_quote_rupees',
      'max_autonomous',
      1,
      999_999_999,
      'The maximum autonomous quote must be whole rupees, digits only.',
    ],
  ] as const;

  for (const [, name, low, high, complaint] of fields) {
    const raw = field(name);
    if (raw === '') continue;
    const parsed = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isInteger(parsed) || parsed < low || parsed > high) {
      return { status: 'error', message: complaint };
    }
  }

  let set = 0;
  for (const [key, name] of fields) {
    const raw = field(name);
    if (raw !== '') set += 1;
    const result = await setOrganizationSetting(key, raw);
    if (!result.ok) return { status: 'error', message: result.error.message };
  }

  revalidatePath('/settings');
  return {
    status: 'success',
    message:
      set === 0
        ? 'All limits cleared. Nothing bounds what the agent does on its own except the rules already in the system.'
        : `${set} limit${set === 1 ? '' : 's'} saved. They bound what happens with nobody looking; your own approvals are never refused by them.`,
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
  // G-236: RECORDED, not only shown. The readiness page reads these two keys;
  // until now the answer vanished with the form and the page stayed amber.
  const at = new Date().toISOString();
  const recorded = await setOrganizationSetting('whatsapp_verified_at', at);
  if (!recorded.ok) return { status: 'error', message: `Meta answered, but the verification could not be recorded: ${recorded.error.message}` };
  const number = [r.displayPhoneNumber, r.verifiedName ? `“${r.verifiedName}”` : null].filter(Boolean).join(' ');
  if (number) await setOrganizationSetting('whatsapp_verified_number', number.slice(0, 80));
  revalidatePath('/settings');
  revalidatePath('/production-readiness');
  return { status: 'success', message: `${parts.join(' · ')} · recorded ${at}` };
}

/**
 * The controlled first send the readiness page prescribes — G-236. One text
 * to the owner-controlled internal recipient, through the same sender every
 * client message uses, with the same token. Nothing reaches a client. The
 * moment is recorded so the page can say it happened, and the audit row of
 * the setting says who asked for it.
 */
export async function sendWhatsAppTestAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return { status: 'error', message: 'Only an owner or ops admin may send the test message.' };
  const settings = await readOperationalSettings();
  const phoneNumberId = settingText(settings, 'whatsapp_phone_number_id');
  const recipient = settingText(settings, 'whatsapp_test_recipient');
  if (!phoneNumberId) return { status: 'error', message: 'No phone number id is set for this organization.' };
  if (!recipient) return { status: 'error', message: 'No internal test recipient is set — set one above first.' };
  const at = new Date().toISOString();
  const sent = await sendWhatsAppText({
    phoneNumberId,
    to: recipient.replace(/^\+/, ''),
    body: `AgencyOS test message · ${at}. This is the controlled first send from your deployment; nothing reached a client.`,
  });
  if (!sent.ok) return { status: 'error', message: `WhatsApp did not accept the test message: ${sent.message}` };
  const recorded = await setOrganizationSetting('whatsapp_test_sent_at', at);
  if (!recorded.ok) return { status: 'error', message: `Sent (${sent.providerRef}), but the moment could not be recorded: ${recorded.error.message}` };
  revalidatePath('/settings');
  revalidatePath('/production-readiness');
  return { status: 'success', message: `Sent to ${recipient} · Meta reference ${sent.providerRef} · recorded ${at}` };
}

/**
 * Exercise every registered AI provider against its real API — G-236, widened
 * by G-238. The readiness page asked for this on a page that had no such
 * control. One structured call per registered provider, each probed with its
 * own small model (PROBE_MODELS), each answer checked; the moment is recorded
 * when at least one answered, and the message says which did and which
 * refused, by name. Not an agent run: nothing is booked to an agent's
 * ceiling, and the cost is said in the message.
 *
 * Review of G-238: the first draft probed claude-sonnet-5 only, so a
 * deployment whose only key was OpenAI's read "configured" and could never
 * verify.
 */
export async function verifyAiProviderAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return { status: 'error', message: 'Only an owner or ops admin may verify the provider.' };
  const registered = await configuredProviders();
  if (registered.length === 0) return { status: 'error', message: 'No AI provider is configured; there is nothing to verify.' };

  const answered: string[] = [];
  const refused: string[] = [];
  let costMinor = 0;
  for (const id of registered) {
    const model = PROBE_MODELS[id];
    if (!model) { refused.push(`${id}: no probe model is named for it`); continue; }
    const provider = await resolveProvider(model);
    if (!provider.ok || provider.data.id !== id) { refused.push(`${id}: ${provider.ok ? `${model} is routed to ${provider.data.id}` : provider.error.message}`); continue; }
    const answer = await provider.data.generateStructured({
      model,
      system: 'You are being checked for reachability. Answer only with the JSON the schema asks for.',
      messages: [{ role: 'user', content: 'Reply with {"ok": true}.' }],
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      schemaName: 'provider_reachability',
      maxOutputTokens: 32,
    });
    if (!answer.ok) { refused.push(`${id}: ${answer.error.message}`); continue; }
    const json = answer.data.json as { ok?: unknown } | null;
    if (!json || json.ok !== true) { refused.push(`${id}: answered, but not with the shape asked for`); continue; }
    answered.push(`${id} (${answer.data.model})`);
    costMinor += answer.data.usage.costMinor;
  }

  if (answered.length === 0) return { status: 'error', message: `No provider answered — not recorded as verified. ${refused.join(' · ')}` };
  const at = new Date().toISOString();
  const recorded = await setOrganizationSetting('ai_provider_verified_at', at);
  if (!recorded.ok) return { status: 'error', message: `A provider answered, but the verification could not be recorded: ${recorded.error.message}` };
  await setOrganizationSetting('ai_provider_verified_model', answered.join(', ').slice(0, 80));
  revalidatePath('/agents');
  revalidatePath('/production-readiness');
  return {
    status: 'success',
    message: `Answered: ${answered.join(', ')} · cost ₹${(costMinor / 100).toFixed(2)}, not booked to any agent · recorded ${at}${refused.length ? ` · refused: ${refused.join(' · ')}` : ''}`,
  };
}

/**
 * Store a provider key through the vault — ADM-84 §9 overturned 2026-09-20.
 * Admin-only at two layers: the check here, and RLS's core.is_admin() policy
 * on ai.provider_credentials, which is the one that counts if this check is
 * ever bypassed. The raw key never touches a log, a revalidated path, or the
 * return value — only whether the write succeeded.
 */
export async function setProviderCredentialAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return { status: 'error', message: 'Only an owner or ops admin may set a provider key.' };

  const provider = String(formData.get('provider') ?? '');
  if (!VAULT_PROVIDERS.includes(provider as VaultProvider)) return { status: 'error', message: `Unknown provider "${provider}".` };
  const key = String(formData.get('key') ?? '');

  const supabase = await createClient();
  const result = await setProviderCredential(supabase, provider as VaultProvider, key, context.userId);
  if (!result.ok) return { status: 'error', message: result.error.message };

  // The resolver's registry is cached per process; a key that just landed
  // must register without waiting for a redeploy (SCR-064).
  resetProviderRegistry();
  revalidatePath('/agents');
  revalidatePath('/agents/routing');
  revalidatePath('/production-readiness');
  return { status: 'success', message: `${provider} key stored — encrypted, never shown again here.` };
}

/**
 * SCR-064 — revoke a vault-stored provider key. Owner only, narrower than
 * storing one; `deleteProviderCredential` says why. The key is never read.
 */
export async function revokeProviderCredentialAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!hasRole(context, 'owner') || !can(context, 'organization.settings')) {
    return { status: 'error', message: 'Only the owner may revoke a provider key.' };
  }

  const provider = String(formData.get('provider') ?? '');
  if (!VAULT_PROVIDERS.includes(provider as VaultProvider)) return { status: 'error', message: `Unknown provider "${provider}".` };

  const supabase = await createClient();
  const result = await deleteProviderCredential(supabase, provider as VaultProvider, context);
  if (!result.ok) return { status: 'error', message: result.error.message };

  resetProviderRegistry();
  revalidatePath('/agents');
  revalidatePath('/agents/routing');
  revalidatePath('/production-readiness');
  return { status: 'success', message: `${provider} key revoked. Agents routed to it will not run until another key is stored or set in the environment.` };
}

/**
 * Exercise the calendar against Google — G-242, ADM-102. One real free/busy
 * read over the next seven days; the answer is `read` (recorded: the moment
 * and the calendar) or `unreadable` with Google's reason (not recorded). A
 * deployment with no credential is told exactly that. Nothing is booked.
 */
export async function verifyCalendarAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return { status: 'error', message: 'Only an owner or ops admin may verify the calendar.' };
  const calendar = await resolveGoogleCalendar();
  if (!calendar) return { status: 'error', message: 'No calendar is configured: place GOOGLE_SERVICE_ACCOUNT_EMAIL in the deployment environment, store the service-account key under Security & Audit › Keys & secrets (or in the environment), and set the calendar id on Integrations (or as GOOGLE_CALENDAR_ID) (ADM-102).' };
  const from = new Date();
  const to = new Date(from.getTime() + 7 * 86_400_000);
  const answer = await calendar.readAvailability({ from: from.toISOString(), to: to.toISOString() });
  if (answer.state !== 'read') {
    return { status: 'error', message: answer.state === 'unreadable' ? `Google did not answer: ${answer.reason}` : 'No calendar is configured.' };
  }
  const at = new Date().toISOString();
  const recorded = await setOrganizationSetting('calendar_verified_at', at);
  if (!recorded.ok) return { status: 'error', message: `Google answered, but the verification could not be recorded: ${recorded.error.message}` };
  const named = await setOrganizationSetting('calendar_verified_calendar', `${answer.source.provider}:${answer.source.calendarId}`.slice(0, 80));
  if (!named.ok) return { status: 'error', message: `Google answered and the moment was recorded, but the calendar's name could not be: ${named.error.message}` };
  revalidatePath('/meetings');
  revalidatePath('/settings');
  return { status: 'success', message: `Reachable — ${answer.source.provider}:${answer.source.calendarId} answered with ${answer.slots.length} free window(s) over the next 7 days · recorded ${at}` };
}

/**
 * The third-party charges the Admin maintains — G-207, audit QM-20.
 *
 * ADM-12's shape applied to money. Before this, the figure in "2% per
 * transaction" was written by a language model and printed verbatim into a
 * client's fixed-price quotation — the one number in the document with no row
 * behind it.
 *
 * An empty charge WITHDRAWS the service, rather than saving a blank: the same
 * gesture the payment-terms form uses, so somebody clearing a row does not
 * have to find a second control to do it with.
 */
export async function setThirdPartyChargeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { setThirdPartyCharge, clearThirdPartyCharge } = await import('@/modules/crm/service');
  const field = (name: string) => String(formData.get(name) ?? '').trim();

  const service = field('charge_service');
  if (!service) return { status: 'error', message: 'Name the service.' };

  const charge = field('charge_amount');
  if (!charge) {
    const cleared = await clearThirdPartyCharge(service);
    if (!cleared.ok) return { status: 'error', message: cleared.error.message };
    revalidatePath('/settings');
    return {
      status: 'success',
      message: `${cleared.data.service} withdrawn. Quotations will name it and print no figure.`,
    };
  }

  const result = await setThirdPartyCharge({
    service,
    charge,
    source: field('charge_source') || null,
    checkedOn: field('charge_checked_on') || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings');
  return {
    status: 'success',
    message: `${result.data.service} recorded. Quotations may now cite it, and only it.`,
  };
}

/**
 * The default internal design reviewer — Designer §4; G-300.
 *
 * The seeded count is surfaced, not swallowed. Saying "saved" while quietly
 * assigning a gate on eleven live projects is the difference between a setting
 * and action at a distance.
 */
export async function setDefaultDesignReviewerAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = String(formData.get('userId') ?? '').trim();
  const result = await setDefaultDesignReviewer(raw === '' ? null : raw);

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings');
  // Every project page shows the gate, and a seeded phase now names somebody.
  revalidatePath('/projects');

  if (result.data.cleared) {
    return {
      status: 'success',
      message: 'Cleared. New projects will start with no reviewer, and existing ones keep theirs.',
    };
  }

  return {
    status: 'success',
    message:
      result.data.seeded === 0
        ? 'Saved. New projects will start with them; nothing already assigned was changed.'
        : `Saved, and assigned to ${result.data.seeded} project${result.data.seeded === 1 ? '' : 's'} that had nobody. Projects that already named somebody were left alone.`,
  };
}

/**
 * Multirole (G-310) — grant or revoke one additional role on a membership.
 * The primary role shown beside every row on the panel is untouched by
 * either of these; see src/lib/admin/settings.ts for what actually changes.
 */
export async function grantSecondaryRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const membershipId = String(formData.get('membershipId') ?? '').trim();
  const role = String(formData.get('role') ?? '').trim();
  if (membershipId === '' || role === '') {
    return { status: 'error', message: 'Choose a person and a role.' };
  }

  const reason = String(formData.get('reason') ?? '');
  const issue = privilegeReasonIssue(reason);
  if (issue) return { status: 'error', message: issue };

  const result = await grantSecondaryRole(membershipId, role);
  if (!result.ok) return { status: 'error', message: result.error.message };

  await recordPrivilegeReason(membershipId, 'secondary_role_granted', reason, { role });
  revalidatePath('/settings');
  revalidatePath('/security');
  return { status: 'success', message: `Granted.` };
}

export async function revokeSecondaryRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const membershipId = String(formData.get('membershipId') ?? '').trim();
  const role = String(formData.get('role') ?? '').trim();
  if (membershipId === '' || role === '') {
    return { status: 'error', message: 'Choose a person and a role.' };
  }

  const reason = String(formData.get('reason') ?? '');
  const issue = privilegeReasonIssue(reason);
  if (issue) return { status: 'error', message: issue };

  const result = await revokeSecondaryRole(membershipId, role);
  if (!result.ok) return { status: 'error', message: result.error.message };

  if (result.data.revoked) await recordPrivilegeReason(membershipId, 'secondary_role_revoked', reason, { role });
  revalidatePath('/settings');
  revalidatePath('/security');
  return {
    status: 'success',
    message: result.data.revoked ? 'Revoked.' : 'That role was not granted, so there was nothing to revoke.',
  };
}

/**
 * Suspends or reactivates a membership — see setMembershipStatus for the
 * refusals (self, last_owner) this can come back with.
 */
export async function setMembershipStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const membershipId = String(formData.get('membershipId') ?? '').trim();
  const status = String(formData.get('status') ?? '').trim();
  if (membershipId === '' || (status !== 'active' && status !== 'suspended')) {
    return { status: 'error', message: 'Choose a person and a status.' };
  }

  const reason = String(formData.get('reason') ?? '');
  const issue = privilegeReasonIssue(reason);
  if (issue) return { status: 'error', message: issue };

  const result = await setMembershipStatus(membershipId, status);
  if (!result.ok) return { status: 'error', message: result.error.message };

  if (result.data.updated) await recordPrivilegeReason(membershipId, 'status_changed', reason, { status });
  revalidatePath('/settings');
  revalidatePath('/security');
  revalidatePath('/security/users');
  return {
    status: 'success',
    message: result.data.updated ? (status === 'suspended' ? 'Suspended.' : 'Reactivated.') : 'Already in that state.',
  };
}

/**
 * How long a quotation stands — configurability audit B-1.
 *
 * Was `VALIDITY_DAYS = 15` in `quotation-standards.ts`, printed on every
 * quotation PDF as "valid for 15 days". The number is the corpus modal, which
 * makes it a fine default and a poor rule. Whole days, 1–90; empty clears,
 * and cleared reads as 15 again — never as zero.
 */
export async function setQuotationValidityAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = String(formData.get('validity_days') ?? '').trim();
  if (raw !== '') {
    const parsed = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
      return { status: 'error', message: 'Validity must be a whole number of days between 1 and 90.' };
    }
  }
  const result = await setOrganizationSetting('quotation_validity_days', raw);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message:
      raw === ''
        ? 'Validity cleared — new quotations say 15 days again. Ones already drafted keep the clause they were drafted with.'
        : `Set. New quotations say they are valid for ${raw} day${raw === '1' ? '' : 's'}; ones already drafted keep the clause they were drafted with.`,
  };
}

/**
 * When follow-ups may be sent — configurability audit B-2.
 *
 * Was `WINDOW_START_HOUR = 10` / `WINDOW_END_HOUR = 19` in
 * `follow-up-rhythms.ts` (ADM-69). The database validates each hour's range;
 * the ORDER of the pair is checked here, because the one-key-at-a-time door
 * cannot see both halves, and the reader falls back to the default for a
 * pair that does not make a window — so a bad save can never send at 03:00.
 * Both empty clears both, and cleared reads as 10–19 again.
 */
export async function setOutreachWindowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const startRaw = String(formData.get('window_start_hour') ?? '').trim();
  const endRaw = String(formData.get('window_end_hour') ?? '').trim();

  if ((startRaw === '') !== (endRaw === '')) {
    return { status: 'error', message: 'Set both hours, or clear both to go back to 10:00–19:00.' };
  }
  if (startRaw !== '') {
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!/^[0-9]+$/.test(startRaw) || !/^[0-9]+$/.test(endRaw) || start < 0 || start > 22 || end < 1 || end > 23) {
      return { status: 'error', message: 'Hours are on the 24-hour clock: start 0–22, end 1–23.' };
    }
    if (start >= end) {
      return { status: 'error', message: `A window from ${start}:00 to ${end}:00 has no hours in it. The end must be after the start.` };
    }
  }

  // Start first, then end: if the second write is refused the reader still
  // sees an unusable pair and keeps the default, so nothing half-applies.
  const first = await setOrganizationSetting('outreach_window_start_hour', startRaw);
  if (!first.ok) return { status: 'error', message: first.error.message };
  const second = await setOrganizationSetting('outreach_window_end_hour', endRaw);
  if (!second.ok) return { status: 'error', message: second.error.message };

  revalidatePath('/settings');
  return {
    status: 'success',
    message:
      startRaw === ''
        ? 'Window cleared — follow-ups go out between 10:00 and 19:00 agency time again.'
        : `Set. Follow-ups go out between ${startRaw}:00 and ${endRaw}:00 agency time, on business days. Ones already due are moved into the window on the next run.`,
  };
}

/**
 * How far ahead a meeting time is offered — configurability audit B-3.
 *
 * Was `DEFAULT_HORIZON_DAYS = 7` in `booking.ts`: the days the calendar is
 * read when a lead named no window. Whole days, 1–60; empty clears, and
 * cleared reads as 7 again — never as zero.
 */
export async function setMeetingOfferHorizonAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = String(formData.get('horizon_days') ?? '').trim();
  if (raw !== '') {
    const parsed = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1 || parsed > 60) {
      return { status: 'error', message: 'The horizon must be a whole number of days between 1 and 60.' };
    }
  }
  const result = await setOrganizationSetting('meeting_offer_horizon_days', raw);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  return {
    status: 'success',
    message:
      raw === ''
        ? 'Horizon cleared — a proposal with no named window reads the next 7 days again.'
        : `Set. A proposal with no named window reads the next ${raw} day${raw === '1' ? '' : 's'} of the calendar.`,
  };
}

/**
 * How many leads the funnel needs before it names a leak — configurability
 * audit B-4.
 *
 * Was `MIN_LEADS_TO_NAME_A_LEAK = 20` in `sales-funnel.ts`. It changes when the
 * report speaks, never a count. Whole leads, 5–500; empty clears, and cleared
 * reads as 20 again.
 */
export async function setFunnelSampleFloorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = String(formData.get('min_leads') ?? '').trim();
  if (raw !== '') {
    const parsed = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isInteger(parsed) || parsed < 5 || parsed > 500) {
      return { status: 'error', message: 'The sample floor must be a whole number of leads between 5 and 500.' };
    }
  }
  const result = await setOrganizationSetting('funnel_min_leads_to_name_leak', raw);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings');
  revalidatePath('/sales-funnel');
  return {
    status: 'success',
    message:
      raw === ''
        ? 'Sample floor cleared — the funnel names its biggest drop from 20 leads again.'
        : `Set. The funnel names its biggest drop once a window holds ${raw} leads.`,
  };
}

/**
 * Publish new wording for one quotation clause — configurability audit B-6.
 *
 * Appends a version and never edits one: a quotation already issued keeps the
 * clause it printed, and only quotations first rendered from here on read the
 * new wording. The database re-checks the role, the length and the shape.
 */
export async function publishQuotationClauseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const key = String(formData.get('clause_key') ?? '');
  if (!isClauseKey(key)) return { status: 'error', message: 'Choose one of the four clauses.' };
  const result = await publishQuotationClause({ key, body: String(formData.get('body') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/commercial');
  revalidatePath('/quotations/new');
  return {
    status: 'success',
    message: result.data.unchanged
      ? `${CLAUSE_LABELS[key]} already says exactly that (version ${result.data.version}); nothing new was published.`
      : `${CLAUSE_LABELS[key]} is now version ${result.data.version}. Quotations already issued keep the wording they printed; the next one to be issued prints this.`,
  };
}

/**
 * SCR-070 — verify Figma. Figma's API reads FILES, so the honest check is to
 * ask it for the most recently recorded design reference: if the token can
 * read that node, the reference is re-recorded as checked (the same door
 * linking uses, carrying its preview and page along so nothing is erased) and
 * its `figma_verified_at` becomes the registry's "last verified". With no
 * reference recorded there is nothing to check the token against, and the
 * message says so rather than claiming a pass.
 */
export async function verifyFigmaAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return { status: 'error', message: 'Only an owner or ops admin may verify Figma.' };

  const { figmaConfigured, lookupNode } = await import('@/lib/figma/client');
  if (!(await figmaConfigured())) return { status: 'error', message: 'No Figma token is configured: store FIGMA_ACCESS_TOKEN under Security › Keys & secrets, then verify.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('theme_options')
    .select('id, figma_file_key, figma_node_id, figma_page_id, preview_asset_url')
    .not('figma_file_key', 'is', null)
    .not('figma_node_id', 'is', null)
    .order('figma_linked_at', { ascending: false })
    .limit(1);
  if (error) return { status: 'error', message: 'The recorded Figma references could not be read, so nothing was verified.' };
  const ref = data?.[0];
  if (!ref?.figma_file_key || !ref.figma_node_id) return { status: 'error', message: 'No design reference is recorded yet, so there is nothing to check the token against. Link a Figma frame on a project’s Design tab, then verify.' };

  const lookup = await lookupNode(ref.figma_file_key, ref.figma_node_id);
  if (!lookup.ok) {
    const said = {
      not_configured: 'No Figma token is configured.',
      unauthorized: 'Figma rejected the token — it has probably been revoked and needs reissuing.',
      forbidden: 'The token is accepted but cannot see the most recent reference’s file. Share the file with the token’s account.',
      not_found: 'Figma no longer has the most recent reference’s file or node.',
      unreachable: 'Figma did not answer. Nothing was changed; try again later.',
    }[lookup.reason];
    return { status: 'error', message: said };
  }

  const { linkThemeFigma } = await import('@/modules/projects/design');
  const recorded = await linkThemeFigma({
    themeOptionId: ref.id,
    fileKey: ref.figma_file_key,
    nodeId: ref.figma_node_id,
    ...(ref.figma_page_id ? { pageId: ref.figma_page_id } : {}),
    ...(ref.preview_asset_url ? { previewUrl: ref.preview_asset_url } : {}),
  });
  if (!recorded.ok) return { status: 'error', message: `Figma answered, but the check could not be recorded: ${recorded.error.message}` };

  revalidatePath('/integrations');
  revalidatePath('/production-readiness');
  return { status: 'success', message: `Reachable — Figma answered for “${lookup.nodeName}” (version ${lookup.version}). Recorded as checked.` };
}

/**
 * A single on/off organization switch — today the payment half of the WON gate
 * (`won_requires_payment_evidence`). The key is checked against an allow-list
 * here and again by the database whitelist; checked = 'on', unchecked clears
 * the key (the gate then enforces only the accepted quotation, as before).
 */
export async function setOrganizationSettingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const key = String(formData.get('key') ?? '');
  const on = formData.get('on') === 'on';

  if (key === 'quotation_translate_standards') {
    const result = await setOrganizationSetting('quotation_translate_standards', on ? 'on' : '');
    if (!result.ok) return { status: 'error', message: result.error.message };
    revalidatePath('/settings/commercial');
    return {
      status: 'success',
      message: on
        ? 'On. A Hindi or Hinglish client’s quotation prints the standard terms in their language too, from the next one rendered.'
        : 'Off. The standard terms print in English whatever language the rest of the quotation is in.',
    };
  }

  if (key !== 'won_requires_payment_evidence') return { status: 'error', message: 'That setting cannot be changed here.' };
  const result = await setOrganizationSetting('won_requires_payment_evidence', on ? 'on' : '');
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/settings/finance');
  return {
    status: 'success',
    message: on
      ? 'On. A deal cannot be marked won until a payment, or an approved no-advance exception, is on record.'
      : 'Off. A deal needs only its accepted quotation to be marked won.',
  };
}
