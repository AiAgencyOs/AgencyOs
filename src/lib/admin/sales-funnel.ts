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

/**
 * One of Doc 09 §25's categories, with how many deals it took.
 *
 * The category tag, never a label. `lib/` may not import `modules/`
 * (ARCHITECTURE.md §3.2), and the labels belong to the sales module — so the
 * page that renders them is the thing that names them, which is also where a
 * label belongs.
 */
export type LostReason = {
  category: string;
  deals: number;
  share: number;
};

export type SalesFunnel = {
  counts: FunnelCounts;
  steps: FunnelStep[];
  /**
   * Doc 09 §37's *"lost reason distribution"* and §30's *"top lost reasons"*.
   *
   * Empty when nothing was lost in the window — not a row of zeroes. The
   * funnel's `lost` count and this can disagree by design: a deal lost before
   * the category existed appears here as "not recorded" rather than being
   * quietly folded into "other", which would be the backfill the constraint
   * deliberately refused.
   */
  lostReasons: LostReason[];
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

  const { data: lost, error: lostError } = await supabase
    .schema('sales')
    .rpc('lost_reasons', { p_from: from, p_to: new Date().toISOString() });

  if (lostError) unreadable('getSalesFunnel.lostReasons', lostError);

  const lostReasons: LostReason[] = (lost ?? []).map((row) => ({
    category: row.lost_category,
    deals: row.deals,
    share: Number(row.share),
  }));

  return { counts, steps, biggestDrop, outOfOrder, lostReasons };
}

/**
 * What the anchor costs — G-172, the corpus study's §24 #13.
 *
 * The study's sharpest commercial finding was that this agency's prices
 * cluster on round anchors and the scope bends to meet them: ₹50,000 bought
 * an app plus an admin panel, a dual-app ERP, a three-role marketplace AND a
 * Netflix-class OTT platform. That is a reflex, and a reflex cannot be argued
 * with until somebody can see what it costs.
 *
 * Every quotation drafted since G-172 carries the formula's reading of its
 * own shape, frozen beside the price at draft time. The gap between the two
 * is not an error — the owner may have had every reason to price below the
 * reference. It is a number that was previously invisible.
 *
 * Read, never computed twice: the reference is whatever was recorded then,
 * not what today's formula would say now. That distinction is the whole
 * reason it is stored rather than derived, and re-deriving it here would
 * quietly undo it.
 *
 * Refuses on failure rather than coalescing to zero (G-054), for the same
 * reason the funnel does: "no gap" and "the database did not answer" are
 * different sentences and only one of them is true.
 */
export type PricingReflex = {
  /** Quotations carrying a recorded reference. Null-safe: zero is honest here. */
  quoted: number;
  /** How many were priced BELOW what the formula read for their shape. */
  below: number;
  /** The summed gap, in whole rupees, across those below. Never negative. */
  belowByRupees: number;
  /** The largest single gap, and the quotation it belongs to. */
  widest: { title: string; proposedRupees: number; referenceRupees: number } | null;
};

type ReferenceRow = {
  title: string;
  document: { pricingReference?: { referenceRupees?: unknown; proposedRupees?: unknown } } | null;
};

export async function getPricingReflex(sinceDays = 90): Promise<PricingReflex> {
  const supabase = await createClient();
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .schema('sales')
    .from('proposals')
    .select('title, document')
    .not('document', 'is', null)
    .gte('created_at', since);

  if (error) unreadable('getPricingReflex', error);

  let quoted = 0;
  let below = 0;
  let belowByRupees = 0;
  let widest: PricingReflex['widest'] = null;

  for (const row of (data ?? []) as ReferenceRow[]) {
    const ref = row.document?.pricingReference;
    const referenceRupees = typeof ref?.referenceRupees === 'number' ? ref.referenceRupees : null;
    const proposedRupees = typeof ref?.proposedRupees === 'number' ? ref.proposedRupees : null;
    // A quotation drafted before G-172 has no reference and is not counted —
    // it is absent from the measurement, not a zero in it.
    if (referenceRupees === null || proposedRupees === null || referenceRupees <= 0) continue;

    quoted += 1;
    const gap = referenceRupees - proposedRupees;
    if (gap <= 0) continue;

    below += 1;
    belowByRupees += gap;
    if (widest === null || gap > widest.referenceRupees - widest.proposedRupees) {
      widest = { title: row.title, proposedRupees, referenceRupees };
    }
  }

  return { quoted, below, belowByRupees, widest };
}
