import 'server-only';

import { createClient } from '@/lib/db/server';
import { firstRow, looseSchema } from '@/lib/p13/loose-client';

import { num, parseNegotiationQueue, type NegotiationQueueRow } from './p1s-negotiation-model';

export { parseNegotiationQueue } from './p1s-negotiation-model';
export type { NegotiationQueueRow } from './p1s-negotiation-model';
import { unreadable } from '@/lib/result';

/**
 * A15 Negotiation workspace (P1-BLUEPRINT-021): the deals being negotiated and the limits they are negotiated under. Both are reads
 * (`sales.p1s_negotiation_queue`, `sales.p1s_limits_in_force`); `src/lib/db/types.ts` is stale for them, so the calls go through the narrow loose view and
 * every field is validated here. A failed read is reported, never shown as an empty queue.
 */

export async function readNegotiationQueue(): Promise<NegotiationQueueRow[]> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'sales').rpc('p1s_negotiation_queue', { p_limit: 200 });
  if (error) unreadable('readNegotiationQueue', error);
  return parseNegotiationQueue(data);
}

export type LimitInForce = { value: number | null; source: 'policy_version' | 'setting' | 'unset'; policyVersion: number | null };
export type LimitsInForce = {
  maxDiscountPct: LimitInForce;
  minPriceRupees: LimitInForce;
  maxAutonomousQuoteRupees: LimitInForce;
  maxRounds: number | null;
  maxDiscountMinor: number | null;
  minAdvancePct: number | null;
};

function limit(raw: unknown): LimitInForce {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const source = o.source === 'policy_version' || o.source === 'setting' ? o.source : 'unset';
  return { value: source === 'unset' ? null : num(o.value), source, policyVersion: num(o.policyVersion) };
}

/** The limits a negotiation is held to, each with where it came from (an active policy version, or the organization setting). */
export async function readLimitsInForce(): Promise<LimitsInForce | null> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'sales').rpc('p1s_limits_in_force');
  if (error) unreadable('readLimitsInForce', error);
  const row = firstRow(data) as Record<string, unknown> | null;
  if (!row || typeof row.limits !== 'object' || row.limits === null) return null;
  const limits = row.limits as Record<string, unknown>;
  const rounds = row.maxRounds === null || row.maxRounds === undefined ? null : Number(row.maxRounds);
  return {
    maxDiscountPct: limit(limits.negotiation_max_discount_pct),
    minPriceRupees: limit(limits.negotiation_min_price_rupees),
    maxAutonomousQuoteRupees: limit(limits.negotiation_max_autonomous_quote_rupees),
    maxRounds: rounds !== null && Number.isFinite(rounds) ? rounds : null,
    maxDiscountMinor: num(row.maxDiscountMinor),
    minAdvancePct: num(row.minAdvancePct),
  };
}
