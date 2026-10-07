/**
 * P4-FIN-042 / 057: the shape of the receipt page the database function `finance.p4s_receipt_page` answers. Pure and client-safe (no session, no storage), so it is
 * tested without a database. A delivery whose state is not one the database knows is dropped rather than shown as sent: an unrecognised state is never a success.
 */
export type ReceiptDocument = {
  receiptNumber: string;
  issuedAt: string;
  amountMinor: number;
  currency: string;
  invoiceNumber: string | null;
  milestone: string | null;
  milestonePosition: number | null;
  client: string | null;
  method: string | null;
  transactionReference: string | null;
  paidAt: string | null;
  receivingAccount: { kind: string; label: string; instructions: unknown } | null;
};

export type ReceiptDeliveryState = 'pending' | 'sent' | 'delivered' | 'failed' | 'unknown';
export type ReceiptDelivery = { channel: string; state: ReceiptDeliveryState; evidence: string | null; attempts: number; updatedAt: string };
export type ReceiptPage = { document: ReceiptDocument; deliveries: ReceiptDelivery[] };

const STATES = new Set(['pending', 'sent', 'delivered', 'failed', 'unknown']);

export function shapeReceiptPage(raw: unknown): ReceiptPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { document?: unknown; deliveries?: unknown };
  if (!r.document || typeof r.document !== 'object') return null;
  const deliveries = Array.isArray(r.deliveries) ? (r.deliveries as Array<Record<string, unknown>>) : [];
  return {
    document: r.document as ReceiptDocument,
    deliveries: deliveries
      .filter((d) => STATES.has(String(d.state)))
      .map((d) => ({
        channel: String(d.channel ?? ''),
        state: d.state as ReceiptDeliveryState,
        evidence: typeof d.evidence === 'string' ? d.evidence : null,
        attempts: Number(d.attempts ?? 0),
        updatedAt: String(d.updatedAt ?? ''),
      })),
  };
}

/** What the delivery state means, in words. `unknown` says it was not confirmed: it is never read as sent. */
export function deliveryExplanation(state: ReceiptDeliveryState): string {
  switch (state) {
    case 'delivered':
      return 'The provider confirmed delivery.';
    case 'sent':
      return 'Handed to the provider; delivery is not confirmed.';
    case 'failed':
      return 'Sending failed. The receipt has not reached the client on this channel.';
    case 'unknown':
      return 'The outcome is not known (for example the request timed out after it may have gone out). Check before sending again.';
    default:
      return 'Not sent yet.';
  }
}
