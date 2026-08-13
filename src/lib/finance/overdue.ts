import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

/**
 * Marking invoices overdue — gap G-004.
 *
 * `overdue` has been in the status vocabulary and in `INVOICE_TRANSITIONS`
 * since the schema was written, and nothing ever performed the transition. A
 * due date passed and the invoice went on describing itself as issued, which
 * made every report of what was late wrong by however many invoices had
 * quietly aged.
 *
 * Runs on the cron tick. It marks state and stops: chasing the client is a
 * message, which is client-facing and waits on the outbound policy rather than
 * being smuggled in behind a status change.
 *
 * A failure never fails the tick, for the same reason alerting and expiry do
 * not. An invoice marked overdue a minute late is a smaller problem than a job
 * queue that stopped.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type OverdueOutcome = { marked: number; failed: boolean };

export async function markOverdueInvoices(admin: Admin): Promise<OverdueOutcome> {
  const { data, error } = await admin.schema('finance').rpc('mark_overdue_invoices', {
    p_limit: 200,
  });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'markOverdueInvoices', detail: error.message }),
    );
    return { marked: 0, failed: true };
  }

  const rows = (Array.isArray(data) ? data : []) as { invoice_id: string; invoice_number: string }[];

  // One line each. An invoice going overdue is a fact somebody will ask about
  // — "when did it turn red?" — and a count cannot answer that.
  for (const row of rows) {
    console.error(
      JSON.stringify({
        level: 'warn',
        scope: 'invoiceOverdue',
        invoice: row.invoice_id,
        number: row.invoice_number,
      }),
    );
  }

  return { marked: rows.length, failed: false };
}
