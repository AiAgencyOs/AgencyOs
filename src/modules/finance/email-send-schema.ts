import { z } from 'zod';

/**
 * Sending an invoice by email — bucket F, SCR-051. The recipient defaults to
 * the client account's billing email on the form; the door takes whatever
 * address the person confirmed. A note travels in the body under the
 * standard text; nothing else about the bill is typed here — the PDF is the
 * bill.
 */
export const sendInvoiceEmailSchema = z.object({
  invoiceId: z.uuid(),
  to: z.string().trim().email('That is not an email address.'),
  /** `sent` for the bill itself, `reminder` to chase it — the same words finance.invoice_sends keeps. */
  kind: z.enum(['sent', 'reminder']),
  note: z.string().trim().max(1000).optional(),
});
export type SendInvoiceEmailInput = z.infer<typeof sendInvoiceEmailSchema>;
