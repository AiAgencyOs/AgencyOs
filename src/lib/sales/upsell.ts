import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

/**
 * Noticing an opportunity, and telling the team — gap G-036, decision ADM-22.
 *
 * The boundary is §2.7's, not mine:
 *
 *   "There is no price catalog. Every price is quoted per client, by a human.
 *    AgencyOS may identify an opportunity — a completed project, a support
 *    pattern, a feature request — and tell the team. **It must never state a
 *    price**."
 *
 * So this notices and records. It contacts nobody, it prices nothing, and the
 * table it writes to has no column that could hold a price.
 *
 * ── why this is not a message ─────────────────────────────────────────────
 *
 * "Tell the team" is satisfied by a row the team can see. Sending anything —
 * even internally — would need a channel, and the only one that exists is
 * WhatsApp, whose internal group is reserved for approvals. An opportunity is
 * not a decision waiting on somebody, and mixing it into the approval channel
 * would make the channel that must be read into one that can be ignored.
 *
 * A failure never fails the tick, matching the other sweeps: the runner's job
 * is to move work, and an opportunity noticed a minute late is a far smaller
 * problem than a job queue that stopped.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type UpsellOutcome = { detected: number; failed: boolean };

export async function detectUpsellSignals(admin: Admin): Promise<UpsellOutcome> {
  const { data, error } = await admin
    .schema('sales')
    .rpc('detect_upsell_signals', { p_limit: 50 });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'detectUpsellSignals', detail: error.message }),
    );
    return { detected: 0, failed: true };
  }

  const rows = (Array.isArray(data) ? data : []) as {
    signal_id: string;
    signal_project_id: string;
    signal_kind: string;
  }[];

  // One line each rather than a count. A signal is a suggestion that somebody
  // should look at a client, and the project it concerns is the part worth
  // grepping for later.
  for (const row of rows) {
    console.error(
      JSON.stringify({
        level: 'info',
        scope: 'upsellSignal',
        signalId: row.signal_id,
        projectId: row.signal_project_id,
        kind: row.signal_kind,
      }),
    );
  }

  return { detected: rows.length, failed: false };
}
