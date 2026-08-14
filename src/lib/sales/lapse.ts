import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

/**
 * Letting a quotation go cold on the record — gap G-111, decisions ADM-71,
 * ADM-78 and ADM-79.
 *
 * Called from the cron tick alongside `expireOverdueApprovals`, which solves
 * the same problem one schema over: something with a deadline that nobody
 * answered needs a state of its own, or a queue of outstanding work counts it
 * forever.
 *
 * ── what this deliberately does not do ────────────────────────────────────
 *
 * **It notifies nobody.** ADM-79: telling a client their offer expired is a
 * sales action a human takes, carrying a judgement about whether to re-offer,
 * discount, or let it go. An automated message would also be client-facing
 * communication, and the consent policy governing that is ADM-81 — still open.
 * Building a sender now would either pre-empt that decision or quietly widen
 * it.
 *
 * Internally nothing needs sending either: the status change *is* the signal.
 * `LIVE_PROPOSAL_STATUSES` stops counting the row, so a queue of outstanding
 * quotations stops showing it — which is the whole complaint G-111 was raised
 * about.
 *
 * **It never revives or extends.** ADM-78: both would mean editing a validity
 * date that has already passed, and a date that moves was never a commitment.
 * To re-offer, a human drafts the next version, which supersedes this one and
 * leaves it intact as evidence of what was actually offered and when.
 *
 * A failure never fails the tick, for the same reason approval expiry does not:
 * the runner's job is to move work, and a quotation that lapses a minute late
 * is a far smaller problem than a job queue that stopped.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type LapseOutcome = { lapsed: number; failed: boolean };

export async function lapseOverdueProposals(admin: Admin): Promise<LapseOutcome> {
  const { data, error } = await admin
    .schema('sales')
    .rpc('lapse_overdue_proposals', { p_limit: 50 });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'lapseOverdueProposals', detail: error.message }),
    );
    return { lapsed: 0, failed: true };
  }

  const rows = (Array.isArray(data) ? data : []) as {
    lapsed_id: string;
    opportunity_id: string;
    organization_id: string;
  }[];

  // One line each rather than a count, matching approval expiry: every one of
  // these is an offer somebody made that nobody answered, which is the sort of
  // thing worth grepping by proposal id when a deal is reviewed.
  for (const row of rows) {
    console.error(
      JSON.stringify({
        level: 'warn',
        scope: 'proposalLapsed',
        proposalId: row.lapsed_id,
        opportunityId: row.opportunity_id,
        organizationId: row.organization_id,
      }),
    );
  }

  return { lapsed: rows.length, failed: false };
}
