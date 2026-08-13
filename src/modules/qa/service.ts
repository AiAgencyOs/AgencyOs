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

// ── production readiness ───────────────────────────────────────────────────

/** The row `projects.mark_production_ready` returns. */
type ProductionReadyRow = {
  outcome: 'ready' | 'already_ready' | 'not_found' | 'not_ready';
  unmet: string[] | null;
};

/** What each unmet condition means to somebody reading a screen. */
const NOT_READY: Record<string, string> = {
  open_blockers: 'there are open blocker defects',
  open_majors: 'there are open major defects',
  no_approved_build: 'the client has not approved a build',
};

/**
 * Marks a project production ready — ADM-19, G-031.
 *
 * Exactly two conditions, and they are the Admin's: **zero open blockers and
 * majors**, and **a client-approved build**. Payment state and an owner
 * sign-off were offered and left out, so a project can be production ready and
 * unpaid, and nobody countersigns.
 *
 * `project.sign_off` rather than `project.write`. The obvious reuse is wrong by
 * exactly one role — `project.write` includes the delivery lead, and a delivery
 * lead declaring their own work production ready is the review signing its own
 * homework.
 *
 * There is no override, deliberately. ADM-19 offered none, and unlike a project
 * start — where a client is waiting and the owner may force it — nothing
 * downstream is blocked by a project that is not yet production ready.
 */
export async function markProductionReady(projectId: string): Promise<Result<{ ready: boolean }>> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return err('VALIDATION', 'That is not a project id.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'project.sign_off')) {
    return err('FORBIDDEN', 'You do not have permission to sign a project off.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .rpc('mark_production_ready', { p_project_id: projectId });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'markProductionReady', detail: error.message }),
    );
    return err('INTERNAL', 'Could not sign that project off.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as ProductionReadyRow | undefined;

  // A read that returned nothing is a failed read, not an empty answer — G-054.
  if (!row) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'markProductionReady', detail: 'no row returned' }),
    );
    return err('INTERNAL', 'Could not sign that project off.');
  }

  switch (row.outcome) {
    case 'ready':
      return ok({ ready: true });

    // Two people signing the same project off get the same answer, and the
    // date does not move: the moment it became ready is when it first did.
    case 'already_ready':
      return ok({ ready: false });

    case 'not_found':
      return err('NOT_FOUND', 'That project is not in this organization.');

    case 'not_ready': {
      const reasons = (row.unmet ?? []).map((key) => NOT_READY[key] ?? key);
      return err('CONFLICT', `This project is not production ready: ${reasons.join(', ')}.`);
    }

    default:
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'markProductionReady',
          detail: `unrecognised outcome "${String(row.outcome)}"`,
        }),
      );
      return err('INTERNAL', 'Could not sign that project off.');
  }
}
