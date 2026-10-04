import { z } from 'zod';

/**
 * Sending an invoice over WhatsApp — SCR-051, owner decision 2026-09-29
 * (AGENT_BRIEF_D decision 1). The invoice and its PDF go through the same
 * governed door quotations use (`sendClientMessage` / `sendClientDocument`
 * in crm/service.ts), so consent and the 24-hour window keep deciding. The
 * finance.invoice_sends row is written afterwards, naming the message.
 */
export const sendInvoiceWhatsAppSchema = z.object({
  invoiceId: z.uuid(),
  /** The thread it goes on — one of the invoice's client-account, project or lead threads. */
  conversationId: z.uuid(),
  note: z.string().trim().max(600).optional(),
});
export type SendInvoiceWhatsAppInput = z.infer<typeof sendInvoiceWhatsAppSchema>;

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
}

/**
 * The text that goes with the PDF. Facts only — the number, the total, the
 * due date, where to pay — the same facts the PDF prints, so a phone that
 * never opens the attachment still reads the bill.
 */
export function invoiceMessage(input: {
  agencyName: string;
  invoiceNumber: string;
  currency: string;
  totalMinor: number;
  paidMinor: number;
  dueAt: string | null;
  timeZone: string;
  projectName: string | null;
  receivingAccounts: readonly { label: string; fields: readonly { label: string; value: string }[] }[];
}): string {
  const outstanding = Math.max(0, input.totalMinor - input.paidMinor);
  const due = input.dueAt
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: input.timeZone }).format(new Date(input.dueAt))
    : null;

  const lines: string[] = [
    `Invoice ${input.invoiceNumber} from ${input.agencyName}${input.projectName ? ` for ${input.projectName}` : ''}.`,
    `Total: ${money(input.totalMinor, input.currency)}${input.paidMinor > 0 ? ` · outstanding ${money(outstanding, input.currency)}` : ''}${due ? ` · due ${due}` : ''}.`,
  ];

  if (input.receivingAccounts.length > 0) {
    lines.push('Pay into:');
    for (const account of input.receivingAccounts.slice(0, 3)) {
      const details = account.fields.map((f) => `${f.label} ${f.value}`).join(', ');
      lines.push(`• ${account.label}${details ? ` — ${details}` : ''}`);
    }
  }

  lines.push('The PDF follows. Reply here with the payment reference once paid. Thank you.');
  return lines.join('\n');
}

/**
 * The free-maintenance document (Finance §9), said in words. There is nothing to
 * pay and nothing to verify, and the message says so - without a figure, and
 * without a date it was not given: the end of the period is the plan's own.
 */
export function freeMaintenanceMessage(input: {
  agencyName: string;
  invoiceNumber: string;
  endsOn: string | null;
  projectName: string | null;
}): string {
  const until = input.endsOn ? ` until ${input.endsOn}` : '';
  return [
    `${input.agencyName}: the free maintenance included with ${input.projectName ? `"${input.projectName}"` : 'your project'} is active${until}.`,
    `The attached document ${input.invoiceNumber} records it. No payment is needed.`,
  ].join('\n');
}
