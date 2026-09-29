import 'server-only';

import { createClient } from '@/lib/db/server';

/**
 * The Command Center's date-range window — SCR-001.
 *
 * Every other signal on the Overview is a "right now" read (pending, overdue,
 * on hold) and has no window to honour. These four are the ones that DO
 * happen over time, counted over the range the reader picks: leads that
 * arrived, deals that closed won, invoices that were issued, meetings that
 * were completed. Each is a count of rows with a timestamp inside `[since,
 * now)`; nothing is estimated and nothing is averaged.
 *
 * Throws on a failed read so `getOverview()`'s `avail()` wrapper renders
 * DATA UNAVAILABLE rather than a zero that means "the database did not
 * answer".
 */

export const OVERVIEW_WINDOWS = [30, 90, 180, 365] as const;
export type OverviewWindowDays = (typeof OVERVIEW_WINDOWS)[number];
export const DEFAULT_OVERVIEW_WINDOW: OverviewWindowDays = 30;

/** A `?days=` value the page will honour; anything else falls back to the default. */
export function overviewWindow(param: string | undefined): OverviewWindowDays {
  const n = Number(param);
  return (OVERVIEW_WINDOWS as readonly number[]).includes(n) ? (n as OverviewWindowDays) : DEFAULT_OVERVIEW_WINDOW;
}

export type WindowActivity = {
  sinceDays: number;
  leadsCreated: number;
  dealsWon: number;
  invoicesIssued: number;
  meetingsCompleted: number;
};

export async function readWindowActivity(sinceDays: number = DEFAULT_OVERVIEW_WINDOW): Promise<WindowActivity> {
  const supabase = await createClient();
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const [leads, won, invoices, meetings] = await Promise.all([
    supabase
      .schema('crm')
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null)
      .gte('created_at', since),
    supabase
      .schema('sales')
      .from('opportunities')
      .select('id', { count: 'exact', head: true })
      .eq('stage', 'won')
      .gte('closed_at', since),
    supabase
      .schema('finance')
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .gte('issued_at', since),
    supabase
      .schema('crm')
      .from('meetings')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('completed_at', since),
  ]);

  for (const read of [leads, won, invoices, meetings]) {
    if (read.error) throw read.error;
  }

  return {
    sinceDays,
    leadsCreated: leads.count ?? 0,
    dealsWon: won.count ?? 0,
    invoicesIssued: invoices.count ?? 0,
    meetingsCompleted: meetings.count ?? 0,
  };
}
