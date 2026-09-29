import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * The assigned team on a client — SCR-015 (`core.client_account_members`,
 * door `core.set_client_account_team`, migration 20261001110000). The set
 * is replaced whole: what the multi-select shows is what the table holds.
 * `project.write`, like every other client edit; the function checks that
 * every id holds an active membership of this organization and audits the
 * change as `client_account.team_set`.
 */

export const setClientTeamSchema = z.object({
  clientAccountId: z.uuid(),
  userIds: z.array(z.uuid()).max(50),
});
export type SetClientTeamInput = z.infer<typeof setClientTeamSchema>;

export async function setClientTeam(input: SetClientTeamInput): Promise<Result<{ count: number }>> {
  const parsed = setClientTeamSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid team.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to assign a client’s team.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('set_client_account_team', {
    p_client_account_id: parsed.data.clientAccountId,
    p_user_ids: parsed.data.userIds,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setClientTeam', detail: error.message }));
    return err('INTERNAL', 'Could not save the team.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ count: new Set(parsed.data.userIds).size });
    case 'not_found':
      return err('NOT_FOUND', 'Client not found.');
    case 'not_a_member':
      return err('CONFLICT', 'Somebody on that list is not an active member of this organization.');
    default:
      return err('FORBIDDEN', 'You do not have permission to assign a client’s team.');
  }
}

export async function readClientTeam(clientAccountId: string): Promise<string[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('client_account_members').select('user_id').eq('client_account_id', clientAccountId).order('created_at');
  if (error) unreadable('readClientTeam', error);
  return (data ?? []).map((r) => r.user_id);
}
