'use server';

import { agencyClock } from '@/lib/admin/agency-clock';
import { getAuthContext } from '@/lib/auth/session';
import { isInternalRole } from '@/lib/auth/claims';

import { listAnnotatedActionItems } from './annotated-items';

export type ActionCount = { total: number; urgent: number };

/**
 * The number on the bell. Fetched by the header AFTER the page has rendered
 * and again whenever a subscribed table changes, so the layout's own render
 * path makes no database read (the cost the earlier "no badge" decision was
 * protecting) while the count still moves the moment an approval lands.
 *
 * Counts only rows still needing this person — read, resolved and
 * snoozed-until-later rows are excluded, exactly as the page shows them
 * (`annotated-items.ts`).
 *
 * Signed-out or non-internal callers get zero rather than an error: the bell
 * is decoration on a page such a caller cannot reach anyway.
 */
export async function countActionItemsAction(): Promise<ActionCount> {
  const context = await getAuthContext();
  if (!context || !isInternalRole(context.role)) return { total: 0, urgent: 0 };
  const clock = await agencyClock();
  const rows = (await listAnnotatedActionItems(context, clock)).filter((r) => r.attention);
  return { total: rows.length, urgent: rows.filter((r) => r.urgent).length };
}
