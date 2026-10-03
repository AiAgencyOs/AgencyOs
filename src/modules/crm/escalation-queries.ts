import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Who a lead is assigned to, for the communication centre's handoff
 * controls — SCR-057. `listActiveConversations` deliberately carries no
 * assignee (the thread list did not need one); this answers for the leads
 * on screen in one read rather than widening that reader's shape.
 */
export async function listLeadAssignees(leadIds: readonly string[]): Promise<Map<string, string | null>> {
  const assignees = new Map<string, string | null>();
  // A project group conversation has no lead; PostgREST would read the null as the text "null".
  const ids = leadIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return assignees;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, assigned_to')
    .in('id', ids);

  if (error) unreadable('listLeadAssignees', error);

  for (const row of data ?? []) assignees.set(row.id, row.assigned_to);
  return assignees;
}
