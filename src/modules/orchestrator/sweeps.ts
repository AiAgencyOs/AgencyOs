import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { expireLeases } from './orchestrator-service';

type Admin = ReturnType<typeof createAdminClient>;

/** A build request nobody reported on within this long is a failed dispatch, said visibly (`projects.expire_stale_build_requests`). */
export const STALE_BUILD_REQUEST_AFTER = '2 hours';

type Loose = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };

/**
 * The two sweeps the Orchestrator's records need on the cron tick: a stale build request is settled as `dispatch_failed`, and a concurrency lease
 * past its time is expired, so a worker that crashed holding files does not hold them forever. Both go through service-role doors that re-check the
 * caller; the tick has already authenticated the request (`authorizeCronRequest`) before it reaches here. Best effort: a failed sweep is logged and
 * the tick carries on, because the queue behind it must not wait on housekeeping.
 */
export async function sweepStaleOrchestratorRecords(admin: Admin): Promise<{ buildRequestsExpired: number | null; leasesExpired: number | null }> {
  let buildRequestsExpired: number | null = null;
  let leasesExpired: number | null = null;
  try {
    const { data, error } = await (admin.schema('projects') as unknown as Loose).rpc('expire_stale_build_requests', { p_older_than: STALE_BUILD_REQUEST_AFTER });
    const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; expired?: number } | undefined;
    if (error || row?.outcome !== 'swept') {
      console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `stale build requests: ${error ? error.message : `the door answered ${row?.outcome ?? 'nothing'}`}` }));
    } else {
      buildRequestsExpired = Number(row.expired ?? 0);
    }
    const leases = await expireLeases(admin);
    if (leases.ok) leasesExpired = leases.expired;
    else console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `expired leases: ${leases.detail}` }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `orchestrator sweeps: ${e instanceof Error ? e.message : 'unknown'}` }));
  }
  return { buildRequestsExpired, leasesExpired };
}

/**
 * The finance exception sweep (Phase 9): opens overdue and overpayment exceptions idempotently and closes an overdue one whose state changed.
 * It writes only to the exceptions table (never a payment, invoice or refund) through a runner-only door. Best effort, like the sweeps above.
 */
export async function sweepFinanceExceptions(admin: Admin): Promise<{ openedOverdue: number; openedOverpayment: number; resolvedOverdue: number } | null> {
  try {
    const { data, error } = await (admin.schema('finance') as unknown as Loose).rpc('sweep_finance_exceptions', { p_limit: 200 });
    const row = (Array.isArray(data) ? data[0] : data) as { opened_overdue?: number; opened_overpayment?: number; resolved_overdue?: number } | undefined;
    if (error || !row) {
      console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `finance exception sweep: ${error ? error.message : 'the door answered nothing'}` }));
      return null;
    }
    return { openedOverdue: Number(row.opened_overdue ?? 0), openedOverpayment: Number(row.opened_overpayment ?? 0), resolvedOverdue: Number(row.resolved_overdue ?? 0) };
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `finance exception sweep: ${e instanceof Error ? e.message : 'unknown'}` }));
    return null;
  }
}

/**
 * The post-launch maintenance sweeps (Phase 8C), one tick: the 8A renewal sweep (a plan past its end date lapses, a plan near it is flagged; nothing is ever
 * renewed here), the payment-gate sweep (an expired exception on an unpaid plan suspends its entitlement), the SLA-breach sweep (an Admin-set target passed:
 * recorded once and escalated to a person) and the stall sweep (a work item that cannot move is recorded with its reason). Each is a service-role door that
 * re-checks the caller; none invents hours, sends to a client, bills or changes a work item's status. Best effort: one failing sweep is logged and the rest run.
 */
export async function sweepMaintenanceLifecycle(admin: Admin): Promise<Record<string, Record<string, number> | null>> {
  const projects = admin.schema('projects') as unknown as Loose;
  const doors: { name: string; args: Record<string, unknown>; fields: string[] }[] = [
    { name: 'sweep_maintenance_renewals', args: {}, fields: ['flagged', 'expired'] },
    { name: 'sweep_maintenance_plan_payment_gates', args: {}, fields: ['checked', 'flagged'] },
    { name: 'sweep_maintenance_sla', args: { p_limit: 500 }, fields: ['checked', 'breached', 'skipped_no_policy'] },
    { name: 'sweep_maintenance_stalls', args: { p_limit: 500 }, fields: ['checked', 'marked'] },
  ];
  const out: Record<string, Record<string, number> | null> = {};
  for (const door of doors) {
    try {
      const { data, error } = await projects.rpc(door.name, door.args);
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      if (error || !row) {
        console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `${door.name}: ${error ? error.message : 'the door answered nothing'}` }));
        out[door.name] = null;
      } else {
        out[door.name] = Object.fromEntries(door.fields.map((f) => [f, Number(row[f] ?? 0)]));
      }
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `${door.name}: ${e instanceof Error ? e.message : 'unknown'}` }));
      out[door.name] = null;
    }
  }
  return out;
}
