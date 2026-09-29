import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Follow-up reminders for the Today card — SCR-001 "Today: meetings, due
 * items, reminders, payment verifications" (bucket F, stream F-A). The card
 * had meetings, the person's due tasks and payments to verify; the
 * reminders were missing. A reminder is a lead whose `next_follow_up_at`
 * falls inside the agency's today, or has already passed without the lead
 * being closed — the same column `setLeadFollowUpAction` writes and the
 * Lead 360 shows as "Next follow-up".
 */

export type FollowUpReminder = {
  leadId: string;
  title: string;
  dueAt: string;
  /** True when the follow-up was due before today began. */
  overdue: boolean;
  assignedTo: string | null;
};

const CLOSED_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'converted', 'merged'];

export async function listFollowUpReminders(window: { from: Date; to: Date }, limit = 10): Promise<FollowUpReminder[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, title, next_follow_up_at, assigned_to, status')
    .not('next_follow_up_at', 'is', null)
    .lt('next_follow_up_at', window.to.toISOString())
    .is('deleted_at', null)
    .not('status', 'in', `(${CLOSED_LEAD_STATUSES.join(',')})`)
    .order('next_follow_up_at', { ascending: true })
    .limit(limit);
  if (error) unreadable('listFollowUpReminders', error);

  const fromMs = window.from.getTime();
  return (data ?? []).map((l) => ({
    leadId: l.id,
    title: l.title,
    dueAt: l.next_follow_up_at as string,
    overdue: new Date(l.next_follow_up_at as string).getTime() < fromMs,
    assignedTo: l.assigned_to,
  }));
}
