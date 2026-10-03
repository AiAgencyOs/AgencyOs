import { splitTax } from './gstr';

/**
 * How an invoice is SHOWN — pure, so the detail page, the composer's review
 * step and the tests say the same thing (PDF SCR-052).
 */

// ── the account number is not printed in full in the admin UI ───────────────

/**
 * `50100234567890` → `••••••7890`. The PDF the client receives carries the
 * number in full (it is what they pay into); the admin screens do not: "never
 * expose secret payment/account credentials beyond intended display fields".
 * Four trailing characters are kept, the rest is masked; anything of four
 * characters or fewer is masked whole, so a short value is never revealed by
 * its own length.
 */
export function maskAccountNumber(value: string): string {
  const v = value.trim();
  if (v.length === 0) return '';
  if (v.length <= 4) return '•'.repeat(v.length);
  return `${'•'.repeat(Math.min(v.length - 4, 8))}${v.slice(-4)}`;
}

/** Account-number-like keys are masked; every other instruction field is shown as written. */
export const MASKED_ACCOUNT_KEYS: ReadonlySet<string> = new Set(['account_number']);

export function displayInstruction(key: string, value: string): string {
  return MASKED_ACCOUNT_KEYS.has(key) ? maskAccountNumber(value) : value;
}

// ── the tax, split the way a GST invoice states it ──────────────────────────

export type TaxBreakdownRow = { label: string; amountMinor: number };
export type TaxBreakdown = {
  rows: TaxBreakdownRow[];
  /** Why the tax is what it is: always stated, never implied. */
  reason: string;
};

function pct(taxMinor: number, subtotalMinor: number): string {
  if (subtotalMinor <= 0) return '';
  const p = Math.round((taxMinor / subtotalMinor) * 1000) / 10;
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

/**
 * What the tax line says, by the project's CONFIRMED billing mode and where the
 * supply went (supplier state vs the client's place of supply).
 *
 *   mode unknown      no split can be stated — said, not guessed
 *   non_gst           no GST: "billed without GST", with the confirmed mode as the reason
 *   gst, tax = 0      GST mode but nothing charged on the lines
 *   gst, same state   CGST + SGST in halves (the odd paisa to SGST, as `splitTax`)
 *   gst, other state  IGST
 *   gst, a state code missing on either side: one GST line and the reason the split is not stated
 */
export function taxBreakdown(input: {
  mode: 'gst' | 'non_gst' | null;
  subtotalMinor: number;
  taxMinor: number;
  supplierStateCode: string | null;
  placeOfSupplyCode: string | null;
}): TaxBreakdown {
  const { mode, subtotalMinor, taxMinor } = input;
  if (mode === null) {
    return { rows: taxMinor > 0 ? [{ label: 'Tax', amountMinor: taxMinor }] : [], reason: 'The billing mode is not confirmed for this project, so no tax split can be stated.' };
  }
  if (mode === 'non_gst') {
    return {
      rows: taxMinor > 0 ? [{ label: 'Tax', amountMinor: taxMinor }] : [],
      reason: taxMinor > 0 ? 'Tax is recorded although the confirmed billing mode is Non-GST.' : 'No GST: this project is billed without GST (confirmed billing mode: Non-GST).',
    };
  }
  if (taxMinor === 0) {
    return { rows: [], reason: 'Billing mode is GST, but no tax was charged on the lines of this invoice.' };
  }
  const rate = pct(taxMinor, subtotalMinor);
  if (!input.supplierStateCode || !input.placeOfSupplyCode) {
    return {
      rows: [{ label: rate ? `GST @ ${rate}%` : 'GST', amountMinor: taxMinor }],
      reason: !input.supplierStateCode
        ? 'The agency’s own GST state is not set (Settings › Finance), so CGST / SGST / IGST cannot be split.'
        : 'The client’s place of supply has no state code on the billing profile, so CGST / SGST / IGST cannot be split.',
    };
  }
  const split = splitTax(taxMinor, input.supplierStateCode, input.placeOfSupplyCode);
  if (split.igst > 0) {
    return { rows: [{ label: `IGST @ ${rate}%`, amountMinor: split.igst }], reason: 'Supplied to a different state, so the tax is IGST.' };
  }
  const half = pct(taxMinor / 2, subtotalMinor);
  return {
    rows: [
      { label: `CGST @ ${half}%`, amountMinor: split.cgst },
      { label: `SGST @ ${half}%`, amountMinor: split.sgst },
    ],
    reason: 'Supplied within the agency’s own state, so the tax is split into CGST and SGST.',
  };
}

// ── the review step before an invoice is issued ─────────────────────────────

export type ReviewItem = { key: string; ok: boolean; label: string; detail: string };

/**
 * The checks a person reads before issuing a draft (PDF SCR-052 "review"). A
 * read of facts already on the row and its profile — it gates nothing itself;
 * the issue door keeps its own refusals.
 */
export function invoiceReviewChecklist(input: {
  lineCount: number;
  totalMinor: number;
  subtotalMinor: number;
  taxMinor: number;
  mode: 'gst' | 'non_gst' | null;
  billingComplete: boolean;
  dueOn: string | null;
  payIntoAccounts: number;
  gstRateBp: number;
}): ReviewItem[] {
  const expectedTax = input.mode === 'gst' ? Math.floor((input.subtotalMinor * input.gstRateBp) / 10_000) : 0;
  return [
    { key: 'lines', ok: input.lineCount > 0 && input.totalMinor > 0, label: 'Lines and amount', detail: input.lineCount > 0 ? `${input.lineCount} line${input.lineCount === 1 ? '' : 's'}` : 'No lines' },
    { key: 'mode', ok: input.mode !== null, label: 'Billing mode confirmed', detail: input.mode === null ? 'Not confirmed for this project' : input.mode === 'gst' ? 'GST' : 'Non-GST' },
    { key: 'billing', ok: input.billingComplete, label: 'Billing details complete', detail: input.billingComplete ? 'Legal name, address and state on file' : 'Something is missing on the billing profile' },
    {
      key: 'tax',
      ok: input.mode !== null && Math.abs(input.taxMinor - expectedTax) <= Math.max(1, input.lineCount),
      label: 'Tax follows the mode',
      detail: input.mode === 'gst' ? 'GST at 18% of the subtotal' : input.mode === 'non_gst' ? 'No GST on the Non-GST path' : 'Cannot be checked without a mode',
    },
    { key: 'due', ok: input.dueOn !== null, label: 'Due date set', detail: input.dueOn ?? 'No due date — the invoice cannot be chased as overdue' },
    { key: 'account', ok: input.payIntoAccounts > 0, label: 'A pay-into account exists', detail: input.payIntoAccounts > 0 ? `${input.payIntoAccounts} active` : 'No active receiving account (Settings › Finance)' },
  ];
}
