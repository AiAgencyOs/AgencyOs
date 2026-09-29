import { z } from 'zod';

import { invoiceTotals, type InvoiceLine } from './schema';

/**
 * SCR-031 "Trigger finance" (migration 20261001120000): an invoice raised
 * for a paid change request. The proposal that prices the change (ADM-22)
 * is the amount; the change request's own words are the line.
 */
export const invoiceChangeRequestSchema = z.object({
  changeRequestId: z.uuid(),
  dueInDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export type InvoiceChangeRequestInput = z.input<typeof invoiceChangeRequestSchema>;

/**
 * The one line a change-request invoice carries — pure, so the arithmetic
 * is tested where the milestone lines are. The proposal's total is the
 * unit price; tax follows the project's billing mode exactly as a
 * milestone invoice's does.
 */
export function changeRequestInvoiceLines(
  input: { requested: string; proposalTitle: string; proposalVersion: number; totalMinor: number; projectName: string },
  taxRateBp: number,
): InvoiceLine[] {
  const words = input.requested.trim().replace(/\s+/g, ' ');
  const excerpt = words.length > 120 ? `${words.slice(0, 117)}…` : words;
  return [
    {
      position: 1,
      description: `${input.projectName} — change request: “${excerpt}” (${input.proposalTitle} v${input.proposalVersion})`,
      quantity: 1,
      unitPriceMinor: input.totalMinor,
      amountMinor: input.totalMinor,
      taxRateBp,
    },
  ];
}

export { invoiceTotals };
