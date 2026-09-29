import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { assignRetestSchema, type AssignRetestInput } from './retest-schema';

/**
 * Assign a retest — SCR-044/046/047. `project.write` like `settleDefect`;
 * `qa.assign_retest` asks `core.can_write()` again, refuses a defect that is
 * not `fixed` (only a fix is retested), writes the assignment row, moves the
 * defect's assignee and audits `defect.retest_assigned`.
 */
export async function assignRetest(input: AssignRetestInput): Promise<Result<{ assignmentId: string }>> {
  const parsed = assignRetestSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid assignment.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to assign a retest.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('assign_retest', {
    p_defect_id: parsed.data.defectId,
    p_retester_id: parsed.data.retesterId,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'assignRetest', detail: error.message }));
    return err('INTERNAL', 'Could not assign the retest.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string; id: string | null } | undefined;
  switch (row?.outcome) {
    case 'assigned':
      return row.id ? ok({ assignmentId: row.id }) : err('INTERNAL', 'Could not assign the retest.');
    case 'not_found':
      return err('NOT_FOUND', 'That defect is not in this organization.');
    case 'not_fixed':
      return err('CONFLICT', 'Only a defect marked fixed is retested. Settle it as fixed first.');
    case 'not_a_member':
      return err('VALIDATION', 'That person is not an active member of this organization.');
    case 'not_authorized':
      return err('FORBIDDEN', 'The database refused: your role may not assign retests.');
    default:
      return err('INTERNAL', `Could not assign the retest (${row?.outcome ?? 'no answer'}).`);
  }
}
