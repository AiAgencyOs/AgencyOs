/**
 * What kind of bill an invoice is — PDF SCR-051: "milestone, change request,
 * maintenance renewal, new service, zero-amount maintenance invoices".
 *
 * The value is stored (`finance.invoices.kind`, written once at insert by the
 * database); this is only its vocabulary and its labels, so the registry's
 * column, its filter and the CSV say the same words.
 */

export const INVOICE_KINDS = ['milestone', 'change_request', 'maintenance_renewal', 'service', 'zero_amount'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = {
  milestone: 'Milestone',
  change_request: 'Change request',
  maintenance_renewal: 'Maintenance renewal',
  service: 'New service',
  zero_amount: 'Zero-amount maintenance',
};

export function isInvoiceKind(value: string | null | undefined): value is InvoiceKind {
  return (INVOICE_KINDS as readonly string[]).includes(value ?? '');
}

export function invoiceKindLabel(value: string | null | undefined): string {
  return isInvoiceKind(value) ? INVOICE_KIND_LABEL[value] : 'Other';
}
