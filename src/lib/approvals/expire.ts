import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

/**
 * Expiring what nobody answered — gap G-096, decision ADM-08c.
 *
 * Called from the cron tick, which is the only caller that could be: the
 * function is granted to `service_role` alone, and the escalation it raises
 * has no human requester because no human asked for it.
 *
 * The rule it enforces is the one directive §29 states and this codebase now
 * enforces twice: **absence of a response is never approval.** An unanswered
 * request becomes `expired` and a fresh one is put to the owner. Nothing here
 * can approve anything, and `decide_approval` would refuse this caller anyway.
 *
 * A failure never fails the tick. The same reasoning as alerting: the runner's
 * job is to move work, and an approval that expires a minute late is a far
 * smaller problem than a job queue that stopped.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type ExpiryOutcome = { expired: number; failed: boolean };

export async function expireOverdueApprovals(admin: Admin): Promise<ExpiryOutcome> {
  const { data, error } = await admin.schema('approvals').rpc('expire_overdue', { p_limit: 50 });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'expireOverdueApprovals', detail: error.message }),
    );
    return { expired: 0, failed: true };
  }

  const rows = (Array.isArray(data) ? data : []) as { expired_id: string; escalation_id: string }[];

  // Logged one line each rather than as a count, because every one of them is
  // somebody's deadline having passed — the sort of thing worth grepping by
  // request id when a client asks why nobody came back to them.
  for (const row of rows) {
    console.error(
      JSON.stringify({
        level: 'warn',
        scope: 'approvalExpired',
        request: row.expired_id,
        escalated_to: row.escalation_id,
      }),
    );
  }

  return { expired: rows.length, failed: false };
}
