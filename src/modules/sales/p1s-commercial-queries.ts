import 'server-only';

import { createClient } from '@/lib/db/server';
import { looseSchema } from '@/lib/p13/loose-client';
import { unreadable } from '@/lib/result';

import { parseCommercialReport, type CommercialReport } from './p1s-commercial-model';

/** P1-CRM-045 / P1-CRM-063: `sales.p1s_commercial_report`, read for the caller's organization. A failed read is reported, never shown as "no deals". */
export async function readCommercialReport(days: number): Promise<CommercialReport | null> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'sales').rpc('p1s_commercial_report', { p_days: days });
  if (error) unreadable('readCommercialReport', error);
  return parseCommercialReport(data);
}
