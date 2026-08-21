import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { AGENT_DEFINITIONS, registryRevision } from './registry';

/**
 * Stamping `ai.agents` with the registry revision it was validated against.
 *
 * ── why this exists in the runtime and not only in a script ────────────────
 *
 * ADM-83 added `definition_version` and `last_validated_at` so that a live row
 * drifting from its definition is *visible*. Enabling an agent is an UPDATE by
 * design, so a production row can diverge with no diff for anybody to review —
 * which is exactly the case the columns were for.
 *
 * The only writer was `scripts/verify-agent-definitions.mjs`, and that script
 * resolves its target through `.env.verify.local`, deliberately, so that a
 * verification run can never compete with the production queue. Correct — and
 * it means the columns had **no producer where drift actually happens**. Read
 * from production on 2026-08-21: NULL on every row, and `/agents` rendered
 * every agent as `never` validated. A field that is always empty teaches a
 * reader to stop looking at it.
 *
 * So the production producer is here, on the tick that already runs every
 * minute under the service role beside the reaper, the outbox and the alerts.
 *
 * ── what it does not do ───────────────────────────────────────────────────
 *
 * It stamps; it does not reconcile. A row whose model, ceilings or enabled
 * flag disagree with the definition is not corrected here — the tick is not
 * the place to decide that a human's `enabled = true` was a mistake. The stamp
 * records *what revision the row was last seen against*, which is what makes
 * a later disagreement legible rather than silent.
 *
 * Agents with no definition are left alone, exactly as the script leaves them:
 * `lead_qualifier` and `proposal_drafter` are preserved rows ADM-82 folded into
 * the sales agent, and there is no revision to validate them against.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type StampSummary = {
  readonly revision: string;
  /** Rows brought up to the current revision on this tick. */
  readonly stamped: number;
  /** Already current; the steady state, and the reason this is cheap. */
  readonly unchanged: number;
  readonly failures: readonly string[];
};

export async function stampAgentDefinitions(admin: Admin): Promise<StampSummary> {
  const revision = registryRevision();
  const defined = AGENT_DEFINITIONS.map((a) => a.key);
  const failures: string[] = [];

  const { data, error } = await admin
    .schema('ai')
    .from('agents')
    .select('key, definition_version')
    .in('key', defined);

  if (error) {
    // Best-effort, like the heartbeat and the alerts beside it. A stamp that
    // cannot be written must not stop the work the tick exists to do.
    return { revision, stamped: 0, unchanged: 0, failures: [error.message] };
  }

  const rows = (data ?? []) as { key: string; definition_version: string | null }[];
  const stale = rows.filter((r) => r.definition_version !== revision);

  if (stale.length === 0) {
    return { revision, stamped: 0, unchanged: rows.length, failures };
  }

  // Scoped to the keys that are actually stale, so the steady state writes
  // nothing at all and `last_validated_at` means "last seen to agree" rather
  // than "last time the tick ran".
  const { error: writeError } = await admin
    .schema('ai')
    .from('agents')
    .update({ definition_version: revision, last_validated_at: new Date().toISOString() })
    .in(
      'key',
      stale.map((r) => r.key),
    );

  if (writeError) {
    failures.push(writeError.message);
    return { revision, stamped: 0, unchanged: rows.length - stale.length, failures };
  }

  return {
    revision,
    stamped: stale.length,
    unchanged: rows.length - stale.length,
    failures,
  };
}
