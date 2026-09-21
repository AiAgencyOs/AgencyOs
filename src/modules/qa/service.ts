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
  draftTestPlanSchema,
  addTestPlanItemSchema,
  removeTestPlanItemSchema,
  type DraftTestPlanInput,
  type AddTestPlanItemInput,
  type RemoveTestPlanItemInput,
  recordTestRunSchema,
  type RecordTestRunInput,
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

/**
 * A test plan authored one item at a time — the human counterpart to a QA
 * agent's structured `testPlanSchema` submission, until that agent exists.
 * `project.write`, matching raiseDefect/settleDefect above: the same
 * capability that changes delivery state.
 */
export async function draftTestPlan(input: DraftTestPlanInput): Promise<Result<{ planId: string }>> {
  const parsed = draftTestPlanSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid scope baseline.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to draft a test plan.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('qa')
    .rpc('draft_test_plan', { p_scope_version_id: parsed.data.scopeVersionId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'draftTestPlan', detail: error.message }));
    return err('INTERNAL', 'Could not draft a test plan.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string } | undefined;

  switch (row?.outcome) {
    case 'drafted':
      if (!row.id) return err('INTERNAL', 'Could not draft a test plan.');
      return ok({ planId: row.id });
    case 'not_active':
      return err('CONFLICT', 'The scope baseline must be frozen before it can be tested.');
    case 'already_exists':
      return err('CONFLICT', 'This baseline already has a test plan.');
    case 'not_found':
      return err('NOT_FOUND', 'Scope baseline not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to draft a test plan.');
  }
}

export async function addTestPlanItem(input: AddTestPlanItemInput): Promise<Result<{ itemId: string }>> {
  const parsed = addTestPlanItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid test plan item.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit a test plan.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('add_test_plan_item', {
    p_plan_id: parsed.data.planId,
    p_scope_item_id: parsed.data.scopeItemId,
    p_category: parsed.data.category,
    p_reason: parsed.data.reason,
    p_critical_path: parsed.data.criticalPath,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addTestPlanItem', detail: error.message }));
    return err('INTERNAL', 'Could not add the item.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string } | undefined;

  switch (row?.outcome) {
    case 'added':
      if (!row.id) return err('INTERNAL', 'Could not add the item.');
      return ok({ itemId: row.id });
    case 'already_planned':
      return err('CONFLICT', 'This item already has that category planned.');
    case 'wrong_baseline':
      return err('VALIDATION', 'That scope item is not part of this plan’s baseline.');
    case 'bad_category':
      return err('VALIDATION', 'Not a testing category this system recognises.');
    case 'bad_reason':
      return err('VALIDATION', 'Say why this category applies to this item.');
    case 'not_found':
      return err('NOT_FOUND', 'Test plan or scope item not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to edit a test plan.');
  }
}

export async function removeTestPlanItem(input: RemoveTestPlanItemInput): Promise<Result<{ removed: boolean }>> {
  const parsed = removeTestPlanItemSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid test plan item.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to edit a test plan.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('qa')
    .rpc('remove_test_plan_item', { p_item_id: parsed.data.itemId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'removeTestPlanItem', detail: error.message }));
    return err('INTERNAL', 'Could not remove the item.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;

  switch (row?.outcome) {
    case 'removed':
      return ok({ removed: true });
    case 'not_found':
      return err('NOT_FOUND', 'Item not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to edit a test plan.');
  }
}

/**
 * Records a test run as evidence against a build — qa.record_test_run
 * (20260921180000). `task.write`-equivalent authority: `can_write()` at the
 * database door admits member, matching Doc 14 §18's explicit admission of
 * manual testing; project.write alone would exclude the person Doc 14 says
 * can do this.
 */
export async function recordTestRun(input: RecordTestRunInput): Promise<Result<{ testRunId: string }>> {
  const parsed = recordTestRunSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid test run.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'task.write')) {
    return err('FORBIDDEN', 'You do not have permission to record test evidence.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('record_test_run', {
    p_deliverable_id: parsed.data.deliverableId,
    p_suite: parsed.data.suite,
    p_total: parsed.data.total,
    p_passed: parsed.data.passed,
    p_failed: parsed.data.failed,
    p_skipped: parsed.data.skipped,
    ...(parsed.data.evidenceUrl ? { p_evidence_url: parsed.data.evidenceUrl } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordTestRun', detail: error.message }));
    return err('INTERNAL', 'Could not record the test run.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string } | undefined;

  switch (row?.outcome) {
    case 'recorded':
      if (!row.id) return err('INTERNAL', 'Could not record the test run.');
      return ok({ testRunId: row.id });
    case 'not_a_build':
      return err('VALIDATION', 'Test evidence names a build deliverable — a design is reviewed, not tested.');
    case 'bad_suite':
      return err('VALIDATION', 'Not a testing suite this system recognises.');
    case 'bad_counts':
      return err('VALIDATION', 'Passed, failed and skipped must add up to the total.');
    case 'not_found':
      return err('NOT_FOUND', 'Build deliverable not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to record test evidence.');
  }
}
