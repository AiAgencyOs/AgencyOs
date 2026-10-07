import 'server-only';

import { createClient } from '@/lib/db/server';
import { looseSchema } from '@/lib/p13/loose-client';
import { unreadable } from '@/lib/result';

import { parseIncidentRows, type IncidentRow } from './incident-model';

export { formatAge, parseIncidentRows } from './incident-model';
export type { IncidentRow, IncidentSeverity, IncidentSource } from './incident-model';

/**
 * A29 (P1-BLUEPRINT-035): the incident / recovery queue, a read of `ai.p1s_incident_queue`. `src/lib/db/types.ts` is stale for it, so the call goes through the
 * narrow loose view and every field is validated here. A failed read is reported, never shown as an empty (all clear) queue.
 */

export async function readIncidentQueue(includeClosed = false): Promise<IncidentRow[]> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'ai').rpc('p1s_incident_queue', { p_include_closed: includeClosed, p_limit: 200 });
  if (error) unreadable('readIncidentQueue', error);
  return parseIncidentRows(data);
}
