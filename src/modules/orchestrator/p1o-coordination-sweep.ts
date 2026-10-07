import type { createAdminClient } from '@/lib/db/admin';
import type { HandlerResult } from '@/modules/crm/handlers';

/**
 * The Coordination sweep (P1-COORD-018/027, P1-SCHED-026): one job per organisation that
 *   * withdraws handoffs tied to a quotation version that is no longer live and marks work behind a dead prerequisite as blocked
 *     (`ai.p1o_invalidate_stale_handoffs`), so nothing is dispatched on obsolete terms, and
 *   * cancels meeting offers whose expiry has passed and flags each for a person (`crm.p1o_expire_stale_proposals`).
 * Both are service-role doors that refuse a signed-in caller. Neither sends anything to anyone. A failed read of either is a retryable failure, never "nothing to
 * sweep". The job is idempotent: a second run finds nothing left to withdraw.
 */

type Admin = ReturnType<typeof createAdminClient>;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export type SweepJob = { organization_id: string };

const row = (v: unknown): Record<string, unknown> => (Array.isArray(v) ? ((v[0] as Record<string, unknown>) ?? {}) : ((v as Record<string, unknown>) ?? {}));
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

export async function runCoordinationSweep(admin: Admin, job: SweepJob): Promise<HandlerResult> {
  const call = (schema: 'ai' | 'crm', fn: string): ReturnType<Rpc> =>
    (admin.schema(schema as never) as unknown as { rpc: Rpc }).rpc(fn, { p_organization_id: job.organization_id });

  const handoffs = await call('ai', 'p1o_invalidate_stale_handoffs');
  if (handoffs.error) return { status: 'failed', permanent: false, detail: `could not sweep stale handoffs: ${handoffs.error.message}` };
  const offers = await call('crm', 'p1o_expire_stale_proposals');
  if (offers.error) return { status: 'failed', permanent: false, detail: `could not expire stale meeting offers: ${offers.error.message}` };

  const h = row(handoffs.data);
  const withdrawn = n(h.withdrawn);
  const blocked = n(h.blocked);
  const expired = n(row(offers.data).expired);
  return {
    status: 'succeeded',
    outcome: withdrawn + blocked + expired > 0 ? 'swept' : 'nothing_to_sweep',
    detail: `${withdrawn} handoff(s) withdrawn, ${blocked} marked blocked, ${expired} meeting offer(s) expired`,
  };
}

/**
 * The tick entry (the same shape as the other sweeps in `sweeps.ts`): every organisation gets its own sweep, best effort, so one organisation's failure never
 * stops the rest and the queue behind the tick never waits on housekeeping. Returns what was done; a failure is logged and counted, never swallowed silently.
 */
export async function sweepCoordinationAllOrganizations(admin: Admin): Promise<{ organizations: number; swept: number; failed: number }> {
  const { data, error } = await admin.schema('core').from('organizations').select('id');
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `coordination sweep: organisations unreadable: ${error.message}` }));
    return { organizations: 0, swept: 0, failed: 1 };
  }
  let swept = 0;
  let failed = 0;
  for (const org of (data ?? []) as Array<{ id: string }>) {
    const r = await runCoordinationSweep(admin, { organization_id: org.id }).catch((e: unknown) => ({ status: 'failed', permanent: false, detail: e instanceof Error ? e.message : 'unknown' }) as const);
    if (r.status === 'succeeded') {
      if (r.outcome === 'swept') swept += 1;
    } else {
      failed += 1;
      console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `coordination sweep for ${org.id}: ${r.detail}` }));
    }
  }
  return { organizations: (data ?? []).length, swept, failed };
}
