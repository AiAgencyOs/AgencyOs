import { invoiceTotals, parseMinorUnits, type InvoiceLine, type InvoiceTotals } from './schema';

/**
 * The invoice composer's arithmetic (PDF SCR-052: "composition … tax mode,
 * billing profile, line items, tax calculation"). Pure and dependency-free:
 * the form previews with it, the review step prints it, and the server door
 * recomputes with it — the client's numbers are never trusted, only its
 * typed text.
 *
 * Money is integer paise from first keystroke: the quantity is kept in
 * hundredths (`finance.invoice_items.quantity` is numeric(12,2)) and a line's
 * amount is `round(quantity × unit price)`, so what the screen shows is what
 * the database stores. The tax rate is not chosen here: it comes from the
 * project's CONFIRMED billing mode (18% GST, or 0 for non-GST), passed in.
 */

export type ComposerLineInput = { description: string; quantity: string; unitPrice: string };

export type ComposedLine = InvoiceLine & { unitPriceLabel: string };

export type Composition =
  | { ok: true; lines: InvoiceLine[]; totals: InvoiceTotals }
  | { ok: false; errors: string[] };

export const MAX_COMPOSER_LINES = 50;

/** `2`, `1.5`, `0.25` → hundredths; null when it is not a positive quantity with at most two decimals. */
export function parseQuantityHundredths(input: string): number | null {
  const cleaned = input.trim();
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const hundredths = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
  return hundredths > 0 ? hundredths : null;
}

export function composeLines(inputs: readonly ComposerLineInput[], taxRateBp: number): Composition {
  const errors: string[] = [];
  if (inputs.length === 0) return { ok: false, errors: ['Add at least one line.'] };
  if (inputs.length > MAX_COMPOSER_LINES) return { ok: false, errors: [`An invoice takes at most ${MAX_COMPOSER_LINES} lines.`] };

  const lines: InvoiceLine[] = [];
  inputs.forEach((input, index) => {
    const n = index + 1;
    const description = input.description.trim();
    const quantity = parseQuantityHundredths(input.quantity);
    const unit = parseMinorUnits(input.unitPrice);
    if (description.length === 0) errors.push(`Line ${n}: say what it is for.`);
    if (description.length > 300) errors.push(`Line ${n}: the description is longer than 300 characters.`);
    if (quantity === null) errors.push(`Line ${n}: the quantity must be a positive number with at most two decimals.`);
    if (unit === null || unit <= 0) errors.push(`Line ${n}: the unit price must be a positive amount with at most two decimals.`);
    if (description.length > 0 && description.length <= 300 && quantity !== null && unit !== null && unit > 0) {
      lines.push({
        position: index,
        description,
        quantity: quantity / 100,
        unitPriceMinor: unit,
        amountMinor: Math.round((quantity * unit) / 100),
        taxRateBp,
      });
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, lines, totals: invoiceTotals(lines) };
}
