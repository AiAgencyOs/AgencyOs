import 'server-only';

import { createClient } from '@/lib/db/server';
import { looseSchema } from '@/lib/p13/loose-client';
import { unreadable } from '@/lib/result';

import { shapeReceiptPage, type ReceiptPage } from './p4s-receipt-shape';

/**
 * P4-FIN-042 / 057: the receipt as a page. One internal-only database function (`finance.p4s_receipt_page`) returns the receipt document and the delivery state of each
 * channel; it returns nothing to a caller who may not read it, so a missing page is "not shown", never "all clear". A failed read is a failure (`unreadable`).
 */
export async function readReceiptPage(receiptId: string): Promise<ReceiptPage | null> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'finance').rpc('p4s_receipt_page', { p_receipt_id: receiptId });
  if (error) unreadable('readReceiptPage', error);
  return shapeReceiptPage(data);
}
