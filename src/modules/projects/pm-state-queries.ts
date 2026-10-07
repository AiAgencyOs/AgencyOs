import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * P4-PM-008/023/024. The PM's Task 2 state (Phase 4 PM spec section 10), derived by `projects.phase_four_pm_state` from the rows that decide it. Empty for a
 * caller who may not read it (another organization, a client, no session): the function returns nothing rather than refusing, so a null here means
 * "not shown", never "READY_TO_START".
 */
export type PhaseFourPmState = { pmState: string; owner: string; blocker: string | null; resumeCondition: string | null };

export async function readPhaseFourPmState(projectId: string): Promise<PhaseFourPmState | null> {
  const supabase = await createClient();
  // db:types is generated from a running database; until it is regenerated this door is called through a loose view of the client
  const projects = supabase.schema('projects') as unknown as {
    rpc(
      fn: string,
      args: Record<string, unknown>,
    ): PromiseLike<{ data: { pm_state: string; owner: string; blocker: string | null; resume_condition: string | null }[] | null; error: { message: string } | null }>;
  };
  const { data, error } = await projects.rpc('phase_four_pm_state', { p_project_id: projectId });
  if (error) unreadable('readPhaseFourPmState', error);
  const row = data?.[0];
  return row ? { pmState: row.pm_state, owner: row.owner, blocker: row.blocker, resumeCondition: row.resume_condition } : null;
}
