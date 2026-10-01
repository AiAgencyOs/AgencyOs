/**
 * The agency's GST setup as organization settings — owner decision 9 of
 * 2026-10-01: "Regular taxpayer, monthly filing (GSTR-1 and GSTR-3B), period =
 * calendar month."
 *
 * Three keys of `core.organizations.settings`, written only by the settings
 * door (`core.set_organization_setting`: owner / ops_admin, whitelisted,
 * validated, audited with old and new):
 *
 *   gst_registration_type   regular | composition
 *   gst_filing_frequency    monthly | quarterly
 *   gst_period_basis        calendar_month
 *
 * UNSET MEANS THE DECISION: regular, monthly, calendar month. Nothing has to
 * be saved for the decision to hold; a saved value records a deliberate change
 * from it, and the screens say which of the two they are showing.
 *
 * Pure and client-safe: the Settings form, the tax page and the export route
 * all read the same function, so they cannot disagree.
 */

export const GST_REGISTRATION_TYPES = ['regular', 'composition'] as const;
export const GST_FILING_FREQUENCIES = ['monthly', 'quarterly'] as const;
export const GST_PERIOD_BASES = ['calendar_month'] as const;

export type GstRegistrationType = (typeof GST_REGISTRATION_TYPES)[number];
export type GstFilingFrequency = (typeof GST_FILING_FREQUENCIES)[number];
export type GstPeriodBasis = (typeof GST_PERIOD_BASES)[number];

export const GST_REGISTRATION_LABEL: Record<GstRegistrationType, string> = { regular: 'Regular taxpayer', composition: 'Composition taxpayer' };
export const GST_FILING_LABEL: Record<GstFilingFrequency, string> = { monthly: 'Monthly (GSTR-1 and GSTR-3B)', quarterly: 'Quarterly' };
export const GST_PERIOD_LABEL: Record<GstPeriodBasis, string> = { calendar_month: 'Calendar month' };

export const GST_SETUP_DEFAULTS = {
  registrationType: 'regular',
  filingFrequency: 'monthly',
  periodBasis: 'calendar_month',
} as const satisfies { registrationType: GstRegistrationType; filingFrequency: GstFilingFrequency; periodBasis: GstPeriodBasis };

export type GstSetup = {
  registrationType: GstRegistrationType;
  filingFrequency: GstFilingFrequency;
  periodBasis: GstPeriodBasis;
  /** Per field: true when the owner saved a value, false when the decision's default is what applies. */
  explicit: { registrationType: boolean; filingFrequency: boolean; periodBasis: boolean };
};

type Settings = Record<string, unknown> | null | undefined;

function pick<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

export function gstSetupFrom(settings: Settings): GstSetup {
  const registrationType = pick(settings?.gst_registration_type, GST_REGISTRATION_TYPES);
  const filingFrequency = pick(settings?.gst_filing_frequency, GST_FILING_FREQUENCIES);
  const periodBasis = pick(settings?.gst_period_basis, GST_PERIOD_BASES);
  return {
    registrationType: registrationType ?? GST_SETUP_DEFAULTS.registrationType,
    filingFrequency: filingFrequency ?? GST_SETUP_DEFAULTS.filingFrequency,
    periodBasis: periodBasis ?? GST_SETUP_DEFAULTS.periodBasis,
    explicit: { registrationType: registrationType !== null, filingFrequency: filingFrequency !== null, periodBasis: periodBasis !== null },
  };
}

/** Validates a posted setup. Null per field means "not one of the allowed values". */
export function parseGstSetup(input: { registrationType: string; filingFrequency: string; periodBasis: string }):
  | { ok: true; value: { registrationType: GstRegistrationType; filingFrequency: GstFilingFrequency; periodBasis: GstPeriodBasis } }
  | { ok: false; message: string } {
  const registrationType = pick(input.registrationType, GST_REGISTRATION_TYPES);
  if (!registrationType) return { ok: false, message: 'Pick a registration type: regular or composition.' };
  const filingFrequency = pick(input.filingFrequency, GST_FILING_FREQUENCIES);
  if (!filingFrequency) return { ok: false, message: 'Pick a filing frequency: monthly or quarterly.' };
  const periodBasis = pick(input.periodBasis, GST_PERIOD_BASES);
  if (!periodBasis) return { ok: false, message: 'The tax period is the calendar month.' };
  return { ok: true, value: { registrationType, filingFrequency, periodBasis } };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The return period the agency files for next, as the `?period=` value the tax
 * page and the exports take: the last COMPLETE calendar month when filing
 * monthly (September's GSTR-1 is prepared in October), the last complete
 * calendar quarter when quarterly.
 */
export function currentReturnPeriod(setup: Pick<GstSetup, 'filingFrequency'>, today: Date): { value: string; label: string } {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-based
  if (setup.filingFrequency === 'quarterly') {
    const q = Math.floor(m / 3) + 1;
    const prev = q === 1 ? { y: y - 1, q: 4 } : { y, q: q - 1 };
    return { value: `${prev.y}-Q${prev.q}`, label: `Q${prev.q} ${prev.y}` };
  }
  const prev = m === 0 ? { y: y - 1, m: 12 } : { y, m };
  const label = new Date(Date.UTC(prev.y, prev.m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { value: `${prev.y}-${pad(prev.m)}`, label };
}

/**
 * Whether a window is a period this agency files for: one calendar month when
 * monthly, one calendar quarter when quarterly. `window` is the resolver's
 * half-open ISO range; null when it is not a whole-month window at all.
 */
export function windowMonths(window: { from: string | null; to: string | null }): number | null {
  if (!window.from || !window.to) return null;
  const from = new Date(window.from);
  const to = new Date(window.to);
  if (from.getUTCDate() !== 1 || to.getUTCDate() !== 1) return null;
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  return months >= 1 ? months : null;
}

export type FilingCheck = { ok: true } | { ok: false; message: string };

/**
 * Whether a GSTR export may be produced for this window under the saved
 * setup. A composition taxpayer does not file GSTR-1 / GSTR-3B; a monthly
 * filer's return is one month, a quarterly filer's one quarter.
 */
export function filingCheck(setup: Pick<GstSetup, 'registrationType' | 'filingFrequency'>, window: { from: string | null; to: string | null }, returnName: 'GSTR-1' | 'GSTR-3B'): FilingCheck {
  if (setup.registrationType === 'composition') {
    return { ok: false, message: `The agency is set up as a composition taxpayer (Settings › Finance), which does not file ${returnName}. Change the registration type there if that is wrong.` };
  }
  const months = windowMonths(window);
  if (setup.filingFrequency === 'monthly' && months !== null && months !== 1) {
    return { ok: false, message: `The agency files monthly (Settings › Finance), so a ${returnName} is for one calendar month. Pick a month, or change the filing frequency there.` };
  }
  if (setup.filingFrequency === 'quarterly' && months !== null && months !== 3) {
    return { ok: false, message: `The agency files quarterly (Settings › Finance), so a ${returnName} is for one calendar quarter. Pick a quarter, or change the filing frequency there.` };
  }
  return { ok: true };
}
