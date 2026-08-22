import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Where the leads are lost — Document 09 §37, and the Sales Dashboard of §30.
 *
 * Read through `crm.sales_funnel`, which counts recorded facts and nothing
 * else. Nothing is computed twice: the stage definitions live in the function,
 * where the tenant pin and the "no invented threshold" rule live with them, and
 * this file turns ten counts into the nine drops between them.
 *
 * Refuses on failure rather than coalescing to zero (G-054). A funnel rendering
 * "0 leads, 0 won" because the database did not answer would tell an owner
 * their month was empty at the exact moment nothing can be known.
 */

export type FunnelCounts = {
  leads: number;
  responded: number;
  engaged: number;
  qualified: number;
  requirementsAccepted: number;
  budgetKnown: number;
  quoted: number;
  negotiating: number;
  won: number;
  lost: number;
  /** Null, never zero, when nothing reached the point being averaged. */
  hoursToFirstReply: number | null;
  hoursToFirstQuote: number | null;
  hoursToWon: number | null;
};

/**
 * One step of the funnel, with the drop into it.
 *
 * `rate` is against the PREVIOUS stage — the leakage the mandate asks to
 * locate. `ofLeads` is against the top, which is the number a target is set
 * in. Both are null when the denominator is zero: a percentage of nothing is
 * not 0%, and printing 0% would name a stage as the leak when no lead ever
 * arrived to leak.
 */
export type FunnelStep = {
  key: string;
  label: string;
  /** What row was counted — so a reader can check the number rather than trust it. */
  evidence: string;
  count: number;
  rate: number | null;
  ofLeads: number | null;
};

export type SalesFunnel = {
  counts: FunnelCounts;
  steps: FunnelStep[];
  /**
   * The largest drop, or null when there is not enough to say.
   *
   * Deliberately not reported below a floor of leads: with four leads the
   * biggest drop is noise, and pointing at a stage on that evidence is the
   * fabricated insight §30 of the mandate forbids. The floor is stated on the
   * page rather than hidden here.
   */
  biggestDrop: { from: string; to: string; lost: number; rate: number } | null;
  /**
   * True when a later stage counts more leads than an earlier one.
   *
   * Not smoothed away. It means deals are reaching a stage without the
   * evidence for the one before — most often closing outside the quotation
   * system — which is a finding worth surfacing rather than a number to fix.
   */
  outOfOrder: boolean;
};

/**
 * Fewer than this and the drops are noise rather than signal.
 *
 * Twenty is not a statistical claim; it is a refusal to name a leak from four
 * leads. The page says so where a reader can see it.
 */
export const MIN_LEADS_TO_NAME_A_LEAK = 20;

const pct = (n: number, of: number): number | null => (of > 0 ? Math.round((n / of) * 1000) / 10 : null);

export async function getSalesFunnel(sinceDays = 90): Promise<SalesFunnel> {
  const supabase = await createClient();

  const from = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .schema('crm')
    .rpc('sales_funnel', { p_from: from, p_to: new Date().toISOString() })
    .maybeSingle();

  if (error) unreadable('getSalesFunnel', error);

  const row = data ?? null;
  const counts: FunnelCounts = {
    leads: row?.leads ?? 0,
    responded: row?.responded ?? 0,
    engaged: row?.engaged ?? 0,
    qualified: row?.qualified ?? 0,
    requirementsAccepted: row?.requirements_accepted ?? 0,
    budgetKnown: row?.budget_known ?? 0,
    quoted: row?.quoted ?? 0,
    negotiating: row?.negotiating ?? 0,
    won: row?.won ?? 0,
    lost: row?.lost ?? 0,
    hoursToFirstReply: row?.hours_to_first_reply ?? null,
    hoursToFirstQuote: row?.hours_to_first_quote ?? null,
    hoursToWon: row?.hours_to_won ?? null,
  };

  /**
   * The order is the mandate's, and each label names the fact behind it.
   *
   * `budget_known` sits beside the funnel rather than in it: knowing a budget
   * is not a stage a lead passes through on the way to a quotation — plenty
   * are quoted without one — so counting it as a step would invent a drop that
   * is not a loss.
   */
  const ordered: ReadonlyArray<[keyof FunnelCounts, string, string]> = [
    ['leads', 'Leads', 'a lead created in the window'],
    ['responded', 'Responded', 'the agency sent something on their thread'],
    ['engaged', 'Engaged', 'they wrote back after we did'],
    ['qualified', 'Qualified', 'the lead’s own status'],
    ['requirementsAccepted', 'Requirements accepted', 'a person accepted a requirement version'],
    ['quoted', 'Quoted', 'a proposal marked sent'],
    ['negotiating', 'Negotiating', 'a deal at the negotiation stage'],
    ['won', 'Won', 'a deal at the won stage'],
  ];

  const steps: FunnelStep[] = ordered.map(([key, label, evidence], i) => {
    const count = counts[key] as number;
    const previous = i === 0 ? null : (counts[ordered[i - 1]![0]] as number);
    return {
      key,
      label,
      evidence,
      count,
      rate: previous === null ? null : pct(count, previous),
      ofLeads: i === 0 ? null : pct(count, counts.leads),
    };
  });

  const outOfOrder = steps.some((s, i) => i > 0 && s.count > steps[i - 1]!.count);

  let biggestDrop: SalesFunnel['biggestDrop'] = null;
  if (counts.leads >= MIN_LEADS_TO_NAME_A_LEAK) {
    for (let i = 1; i < steps.length; i += 1) {
      const from_ = steps[i - 1]!;
      const to = steps[i]!;
      const lost = from_.count - to.count;
      if (lost <= 0) continue;
      const rate = pct(lost, from_.count) ?? 0;
      if (!biggestDrop || lost > biggestDrop.lost) {
        biggestDrop = { from: from_.label, to: to.label, lost, rate };
      }
    }
  }

  return { counts, steps, biggestDrop, outOfOrder };
}
