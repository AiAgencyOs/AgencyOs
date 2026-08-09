import type { Database } from '@/lib/db/types';

type InvoiceRow = Database['finance']['Tables']['invoices']['Row'];
type InvoiceItemRow = Database['finance']['Tables']['invoice_items']['Row'];
type PaymentRow = Database['finance']['Tables']['payments']['Row'];

/**
 * An invoice as the list renders it.
 *
 * Amounts stay in minor units all the way to the formatter. Converting to a
 * float this far from the display layer is how currency bugs start.
 */
export type InvoiceListItem = Pick<
  InvoiceRow,
  | 'id'
  | 'number'
  | 'status'
  | 'currency'
  | 'total_minor'
  | 'paid_minor'
  | 'due_at'
  | 'issued_at'
  | 'project_id'
  | 'milestone_id'
>;

export type InvoiceDetail = InvoiceListItem &
  Pick<InvoiceRow, 'client_account_id' | 'subtotal_minor' | 'tax_minor' | 'paid_at' | 'notes' | 'created_at'>;

export type InvoiceItem = Pick<
  InvoiceItemRow,
  'id' | 'position' | 'description' | 'quantity' | 'unit_price_minor' | 'amount_minor' | 'tax_rate_bp'
>;

/**
 * A recorded payment.
 *
 * `provider` is carried through rather than hidden: on this screen the
 * difference between a human writing down a UTR and a gateway confirming a
 * capture is exactly what the reader needs to know.
 */
export type InvoicePayment = Pick<
  PaymentRow,
  'id' | 'provider' | 'provider_payment_id' | 'amount_minor' | 'currency' | 'status' | 'captured_at'
>;

/**
 * One milestone's billing state, as the project page shows it.
 *
 * `invoice` is null when the milestone has never been billed, or when its only
 * invoice was voided — a voided invoice does not count as billed, which is the
 * same rule the partial unique index enforces in the database.
 */
export type MilestoneBilling = {
  milestoneId: string;
  invoice: InvoiceListItem | null;
};
