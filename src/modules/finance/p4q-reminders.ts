import type { createAdminClient } from '@/lib/db/admin';
import { looseSchema } from '@/lib/p13/loose-client';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * W-F6 (P4-FIN reminders): a reminder has a stage (upcoming, due today, overdue, escalation) and a state (scheduled, sent, failed) of its own.
 *
 * `finance.p4q_schedule_reminders()` writes one row per invoice and stage (and opens the escalation exception once, when an invoice crosses the owner's
 * escalation threshold); `finance.p4q_mark_reminder` records what became of it. The reminder worker calls the first at the start of every sweep and the second
 * after every claim it settles, so the Admin's reminder overview finally has rows to read. Both are best effort: the sweep, its claim and its delivery are
 * unchanged, and a bookkeeping failure is logged and never stops a reminder.
 */
export async function scheduleReminderStages(admin: Admin): Promise<number | null> {
  try {
    const { data, error } = await looseSchema(admin as never, 'finance').rpc('p4q_schedule_reminders', { p_limit: 100 });
    if (error) {
      console.error(JSON.stringify({ level: 'error', scope: 'p4q.reminders.schedule', detail: error.message }));
      return null;
    }
    return Array.isArray(data) ? data.length : 0;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'p4q.reminders.schedule', detail: e instanceof Error ? e.message : 'unknown' }));
    return null;
  }
}

/** Records what became of the reminder the invoice is at the stage of right now. `failed` needs the reason (the door refuses it without one). */
export async function markInvoiceReminder(admin: Admin, invoiceId: string, state: 'sent' | 'failed', note?: string): Promise<'updated' | 'already_sent' | 'no_reminder' | 'failed'> {
  try {
    const finance = looseSchema(admin as never, 'finance');
    const stage = await finance.rpc('p4q_invoice_reminder_stage', { p_invoice_id: invoiceId });
    if (stage.error || typeof stage.data !== 'string') return 'no_reminder';
    const { data: row, error } = await finance.from('p4q_reminders').select('id').eq('invoice_id', invoiceId).eq('stage', stage.data).maybeSingle();
    if (error) {
      console.error(JSON.stringify({ level: 'error', scope: 'p4q.reminders.find', invoice: invoiceId, detail: error.message }));
      return 'failed';
    }
    const id = (row as { id?: string } | null)?.id;
    if (!id) return 'no_reminder';
    const marked = await finance.rpc('p4q_mark_reminder', { p_reminder_id: id, p_state: state, p_note: note ?? null });
    if (marked.error) {
      console.error(JSON.stringify({ level: 'error', scope: 'p4q.reminders.mark', invoice: invoiceId, detail: marked.error.message }));
      return 'failed';
    }
    const outcome = (Array.isArray(marked.data) ? (marked.data[0] as { outcome?: string } | undefined) : (marked.data as { outcome?: string } | null))?.outcome;
    return outcome === 'updated' || outcome === 'already_sent' ? outcome : 'failed';
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'p4q.reminders.mark', invoice: invoiceId, detail: e instanceof Error ? e.message : 'unknown' }));
    return 'failed';
  }
}
