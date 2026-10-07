import type { createAdminClient } from '@/lib/db/admin';
import { firstRow, looseSchema, asRows } from '@/lib/p13/loose-client';
import { notificationVerdict } from '@/lib/p13/notification-gate';

/**
 * P3-PM-030: a design share the client has not answered is chased, at most twice, spaced, and each reminder is recorded.
 *
 * The SQL decides WHO is due (`projects.p13_design_shares_awaiting_decision`: latest share, no decision, phase waiting on the client, under two reminders,
 * spacing respected) and records the reminder (`projects.p13_record_design_share_reminder`: refuses a third, refuses an answered share). This sweep adds
 * the two checks only the application can make, in this order, and sends nothing itself: the INJECTED `send` is the WhatsApp / email sender, and when it
 * cannot send (no number, no consent, no provider) it says so and NO reminder is recorded, so the share is simply due again next sweep.
 *
 *   1. central notification rules (quiet hours, off switch) for event class `client_followup`
 *   2. `send` -> `{ sent: true, channel, evidenceRef }` | `{ sent: false, reason }`
 */
type Admin = ReturnType<typeof createAdminClient>;

export type DueShare = { share_id: string; project_id: string; phase_three_id: string; share_number: number; shared_at: string; reminders_sent: number; next_reminder_number: number };
export type SendResult = { sent: true; channel: 'whatsapp' | 'email' | 'other'; evidenceRef: string } | { sent: false; reason: string };
export type SweepOutcome = { shareId: string; result: 'reminded' | 'held_by_rules' | 'not_sent' | 'refused'; detail: string };

export async function sweepDesignShareReminders(
  admin: Admin,
  input: { organizationId: string; afterHours?: number; betweenHours?: number; now?: Date; channel?: 'whatsapp' | 'email' },
  send: (share: DueShare) => Promise<SendResult>,
): Promise<{ ok: true; outcomes: SweepOutcome[] } | { ok: false; detail: string }> {
  const projects = looseSchema(admin as never, 'projects');
  const due = await projects.rpc('p13_design_shares_awaiting_decision', {
    p_organization_id: input.organizationId,
    p_after_hours: input.afterHours ?? 48,
    p_between_hours: input.betweenHours ?? 48,
  });
  if (due.error) return { ok: false, detail: `could not list the shares awaiting a decision: ${due.error.message}` };

  const outcomes: SweepOutcome[] = [];
  for (const row of asRows(due.data) as unknown as DueShare[]) {
    const verdict = await notificationVerdict(admin, { organizationId: input.organizationId, eventClass: 'client_followup', channel: input.channel ?? 'whatsapp', at: input.now });
    if (!verdict.allowed) {
      outcomes.push({ shareId: row.share_id, result: 'held_by_rules', detail: verdict.reason });
      continue;
    }
    let sent: SendResult;
    try {
      sent = await send(row);
    } catch (e) {
      outcomes.push({ shareId: row.share_id, result: 'not_sent', detail: e instanceof Error ? e.message : 'the sender failed' });
      continue;
    }
    if (!sent.sent) {
      outcomes.push({ shareId: row.share_id, result: 'not_sent', detail: sent.reason });
      continue;
    }
    const rec = await projects.rpc('p13_record_design_share_reminder', { p_share_id: row.share_id, p_channel: sent.channel, p_evidence: sent.evidenceRef });
    if (rec.error) return { ok: false, detail: `a reminder was sent but could not be recorded (${row.share_id}): ${rec.error.message}` };
    const r = firstRow(rec.data);
    outcomes.push(r?.outcome === 'recorded' ? { shareId: row.share_id, result: 'reminded', detail: `reminder ${String(r.reminder_number)}` } : { shareId: row.share_id, result: 'refused', detail: String(r?.outcome ?? 'unknown') });
  }
  return { ok: true, outcomes };
}
