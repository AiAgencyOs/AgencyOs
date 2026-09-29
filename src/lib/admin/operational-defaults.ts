/**
 * Operational settings the product reads with a default behind them.
 *
 * Two values that were constants in code and are now the owner's to set
 * (Admin Manageability Matrix, screen architecture §7: "Payment schedule
 * templates … Outreach frequency caps"; and the configurability audit,
 * docs/AGENCYOS_ADMIN_CONFIGURABILITY_AUDIT.md, items B-1 and B-2). Each
 * reader takes the organization's `settings` JSON as already read by the
 * caller — no round trip of its own — and answers the CONFIGURED value or
 * the default the code always used. Unset means "as before", never "zero".
 *
 * Pure, and importable from anywhere: a module (`sales`, `crm`) and a page
 * both need the same answer, and `lib/` may not depend on `modules/`.
 */

/** How long a quotation stands before it lapses — the corpus modal, 15 days. */
export const DEFAULT_QUOTATION_VALIDITY_DAYS = 15;

/** The hours (inclusive start, exclusive end, agency-local) inside which follow-ups are sent — ADM-69. */
export const DEFAULT_OUTREACH_WINDOW = { startHour: 10, endHour: 19 } as const;

export type OutreachWindow = { startHour: number; endHour: number };

type Settings = Record<string, unknown> | null | undefined;

function wholeNumber(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!/^[0-9]{1,4}$/.test(text)) return null;
  return Number(text);
}

/** `quotation_validity_days`, 1–90, or the default. */
export function quotationValidityDays(settings: Settings): number {
  const n = wholeNumber(settings?.quotation_validity_days);
  return n !== null && n >= 1 && n <= 90 ? n : DEFAULT_QUOTATION_VALIDITY_DAYS;
}

/**
 * `outreach_window_start_hour` / `outreach_window_end_hour`, as a pair.
 *
 * The pair is validated TOGETHER: a start at or after the end is not a
 * window, so either half being unusable falls back to the whole default —
 * a half-configured window that silently sent at 03:00 would be the failure
 * the setting exists to prevent.
 */
export function outreachWindow(settings: Settings): OutreachWindow {
  const start = wholeNumber(settings?.outreach_window_start_hour);
  const end = wholeNumber(settings?.outreach_window_end_hour);
  if (start === null || end === null) return { ...DEFAULT_OUTREACH_WINDOW };
  if (start < 0 || start > 22 || end < 1 || end > 23 || start >= end) return { ...DEFAULT_OUTREACH_WINDOW };
  return { startHour: start, endHour: end };
}
