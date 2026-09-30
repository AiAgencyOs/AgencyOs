/**
 * The project Finance tab's extra lines — pure helpers (no I/O).
 *
 * Every line is a fact the payment and invoice rows already hold: the newest
 * capture date, the methods people said they paid by, the tax the invoices
 * carry. None is a default — a project with no payment shows a dash.
 */

export type ProjectPayment = {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  provider: string;
  /** The method on the payment claim that this payment settled, when one is linked. */
  method: string | null;
  capturedAt: string | null;
  createdAt: string;
};

const METHOD_LABEL: Record<string, string> = { upi: 'UPI', bank_transfer: 'Bank transfer', card: 'Card', cash: 'Cash', cheque: 'Cheque', gateway: 'Payment gateway', other: 'Other' };

/** A method the payer named, else how it was recorded. */
export function methodLabel(payment: Pick<ProjectPayment, 'method' | 'provider'>): string {
  if (payment.method) return METHOD_LABEL[payment.method] ?? payment.method;
  if (payment.provider === 'manual') return 'Recorded manually';
  return payment.provider.charAt(0).toUpperCase() + payment.provider.slice(1);
}

const REAL = new Set(['captured', 'refunded']);

/** Money that actually arrived: captured (or later refunded) payments. */
export function receivedPayments(payments: readonly ProjectPayment[]): ProjectPayment[] {
  return payments.filter((p) => REAL.has(p.status));
}

export function lastPaymentAt(payments: readonly ProjectPayment[]): string | null {
  const dates = receivedPayments(payments).map((p) => p.capturedAt ?? p.createdAt);
  return dates.length === 0 ? null : dates.reduce((a, b) => (a > b ? a : b));
}

/** "Bank transfer / UPI" — the distinct methods, in the order first paid. */
export function methodsUsed(payments: readonly ProjectPayment[]): string {
  const ordered = [...receivedPayments(payments)].sort((a, b) => (a.capturedAt ?? a.createdAt).localeCompare(b.capturedAt ?? b.createdAt));
  const labels = [...new Set(ordered.map(methodLabel))];
  return labels.length === 0 ? '—' : labels.join(' / ');
}

export function transactionStatus(status: string): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  switch (status) {
    case 'captured':
      return { label: 'Completed', tone: 'success' };
    case 'refunded':
      return { label: 'Refunded', tone: 'neutral' };
    case 'failed':
      return { label: 'Failed', tone: 'danger' };
    default:
      return { label: 'Pending', tone: 'warning' };
  }
}

/** The GST line: the tax the live invoices carry, or a plain statement that they carry none. */
export function gstLine(taxMinor: number, format: (minor: number) => string): string {
  return taxMinor > 0 ? `${format(taxMinor)} charged on invoices` : 'No tax on these invoices';
}
