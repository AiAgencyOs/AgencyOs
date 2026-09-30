import 'server-only';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import type { Escalation } from '@/lib/admin/escalation-types';
import { readEscalationsByKey } from '@/lib/admin/escalations';
import { needsAttention, readNotificationStates, type NotificationState } from '@/lib/admin/notification-state';
import type { AuthContext } from '@/lib/auth/session';

import { listActionItems, type ActionItem } from './action-items';

export type AnnotatedItem = ActionItem & {
  /** The caller's annotation of this row, if any — see `lib/admin/notification-state.ts`. */
  state: NotificationState | null;
  /** False when read, resolved, or snoozed until a moment still ahead. */
  attention: boolean;
  /** The open or acknowledged escalation raised on this row, if any (bucket F, `core.escalations`). */
  escalation: Escalation | null;
};

/**
 * The Action Center's rows with the caller's state laid over them. The rows
 * are still derived live (`listActionItems`); the state table only
 * annotates them, so a row that is resolved here and still pending at its
 * source keeps existing — it just stops counting against this person.
 * The escalation, when one is open on the row, rides along the same way.
 *
 * Feeds the page, the dashboard feed and the bell alike, so the number on
 * the bell is the number of rows the page shows as needing attention.
 */
export async function listAnnotatedActionItems(context: AuthContext, clock: AgencyClock): Promise<AnnotatedItem[]> {
  const [items, states, escalations] = await Promise.all([listActionItems(context, clock), readNotificationStates(), readEscalationsByKey()]);
  const now = Date.now();
  return items.map((item) => {
    const state = states.get(item.key) ?? null;
    return { ...item, state, attention: needsAttention(state, now), escalation: escalations.get(item.key) ?? null };
  });
}
