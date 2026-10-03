import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * SCR-040 "Approve plan internally" — `projects.approve_project_plan`
 * (migration 20261006400200). `milestone.write` here (the roles that plan),
 * `can_manage_delivery()` again in the database, which also refuses an empty
 * plan and a plan that is not a draft. Approval is a record beside
 * activation, not a replacement for the validator that activation runs.
 */
const approvePlanSchema = z.object({ planId: z.uuid(), note: z.string().trim().max(1000, 'A note is at most 1000 characters.').default('') });

export async function approveProjectPlan(input: z.input<typeof approvePlanSchema>): Promise<Result<{ approved: true }>> {
  const parsed = approvePlanSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid plan.');
  const context = await requireInternal();
  if (!can(context, 'milestone.write')) return err('FORBIDDEN', 'You do not have permission to approve a plan.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('approve_project_plan', { p_plan_id: parsed.data.planId, p_note: parsed.data.note || undefined });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'approveProjectPlan', detail: error.message }));
    return err('INTERNAL', 'Could not approve the plan.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'approved':
      return ok({ approved: true });
    case 'already_approved':
      return err('CONFLICT', 'This plan is already approved.');
    case 'not_draft':
      return err('CONFLICT', 'Only a draft plan is approved; an active plan has already been.');
    case 'empty_plan':
      return err('CONFLICT', 'A plan with no deliverables cannot be approved.');
    case 'not_found':
      return err('NOT_FOUND', 'Plan not found.');
    case 'too_long':
      return err('VALIDATION', 'A note is at most 1000 characters.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may approve a plan.');
  }
}
