import type { Database } from '@/lib/db/types';

type InvoiceRow = Database['finance']['Tables']['invoices']['Row'];

/**
 * An invoice as the list renders it.
 *
 * Amounts stay in minor units all the way to the formatter. Converting to a
 * float this far from the display layer is how currency bugs start.
 */
export type InvoiceListItem = Pick<
  InvoiceRow,
  'id' | 'number' | 'status' | 'currency' | 'total_minor' | 'paid_minor' | 'due_at' | 'issued_at'
>;
