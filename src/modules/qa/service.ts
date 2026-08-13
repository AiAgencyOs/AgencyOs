import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  raiseDefectSchema,
  settleDefectSchema,
  type RaiseDefectInput,
  type SettleDefectInput,
} from './schema';

/**
 * Writes for QA — gap G-030, directive §19.
 *
 * The module owns one question: what is wrong with what we are about to show
 * the client, and has anybody checked. It gates nothing by itself; the gate
 * lives in `projects.submit_deliverable`, which refuses while an open blocker
 * or major defect stands against the version being submitted
 * (`ARCHITECTURE.md` §4.8).
 *
 * Capabilities are reused rather than invented: `project.write` is already
 * what it takes to change delivery state, and raising or settling a defect is
 * that. A new capability resolving to the same role set would add vocabulary
 * without adding control.
 */

export async function raiseDefect(input: RaiseDefectInput): Promise<Result<{ defectId: string }>> {
  const parsed = raiseDefectSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That defect could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to raise defects.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('qa')
    .from('defects')
    .insert({
      organization_id: context.organizationId,
      project_id: parsed.data.projectId,
      deliverable_id: parsed.data.deliverableId ?? null,
      severity: parsed.data.severity,
      title: parsed.data.title,
      reproduction: parsed.data.reproduction,
      expected: parsed.data.expected ?? null,
      actual: parsed.data.actual ?? null,
      environment: parsed.data.environment ?? null,
      evidence_url: parsed.data.evidenceUrl ?? null,
      reported_by: context.userId,
    })
    .select('id')
    .single();

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'raiseDefect', detail: error.message }));
    return err('INTERNAL', 'Could not raise the defect.');
  }

  return ok({ defectId: data.id });
}

/**
 * Move a defect along.
 *
 * The transition itself is refused by `defects_guard` if it is illegal, and by
 * `defects_verification_shape` if a verification names nobody. This function
 * does not re-check either: a check here would be read-then-write against a
 * row somebody else may settle first, which is the defect this repository has
 * closed a dozen times. It supplies what the constraints need and reports what
 * the database said.
 */
export async function settleDefect(input: SettleDefectInput): Promise<Result<{ status: string }>> {
  const parsed = settleDefectSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That change could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to change defects.');
  }

  const supabase = await createClient();

  const verifying = parsed.data.status === 'verified';

  const { data, error } = await supabase
    .schema('qa')
    .from('defects')
    .update({
      status: parsed.data.status,
      resolution: parsed.data.resolution ?? null,
      // Written together, because the constraint requires both and a
      // verification with no verifier is a status nobody stands behind.
      verified_by: verifying ? context.userId : null,
      verified_at: verifying ? new Date().toISOString() : null,
    })
    .eq('id', parsed.data.defectId)
    // Restated on the write: the status this caller decided against must still
    // be the status when the write lands.
    .neq('status', parsed.data.status)
    .select('id, status, organization_id')
    .maybeSingle();

  if (error) {
    // 23514 is the check constraint, P0001 the guard's own refusal. Both mean
    // the move was illegal, which is a conflict rather than a server fault.
    const illegal = error.message.includes('does not move from') || error.message.includes('already');
    console.error(JSON.stringify({ level: 'error', scope: 'settleDefect', detail: error.message }));
    return illegal
      ? err('CONFLICT', 'That is not a move this defect can make.')
      : err('INTERNAL', 'Could not change the defect.');
  }

  // No row means somebody settled it first, or it was already in this status.
  if (!data) return err('CONFLICT', 'This defect was already changed.');

  return ok({ status: data.status });
}
