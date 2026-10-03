/**
 * SCR-016's header figures for one client: the accepted quote value across its
 * projects and the state of its maintenance and renewals. Pure — it reads the
 * per-project commercials the page already holds, so each sentence can be
 * tested with real rows, and nothing is summed that no row backs.
 *
 * Money is added only within the client's own currency; a project priced in
 * another currency is counted and named, never converted.
 */

export type CommercialRow = {
  currency: string;
  acceptedQuoteMinor: number | null;
  maintenance: { name: string; accepted: boolean; endsOn: string | null } | null;
};

export type CommercialSummary = {
  projects: number;
  /** Projects that cite an accepted quotation, in the client's currency. */
  cited: number;
  acceptedQuoteMinor: number;
  /** Projects priced in some other currency: left out of the sum, and said so. */
  otherCurrency: number;
  maintenance: {
    plans: number;
    notAccepted: number;
    /** An accepted plan whose end date has passed: a renewal is due. */
    lapsed: number;
    /** The soonest end date still ahead, if any plan has one. */
    nextEndsOn: string | null;
  };
};

export function summariseCommercials(rows: readonly CommercialRow[], currency: string, today: string): CommercialSummary {
  let cited = 0;
  let acceptedQuoteMinor = 0;
  let otherCurrency = 0;
  let plans = 0;
  let notAccepted = 0;
  let lapsed = 0;
  let nextEndsOn: string | null = null;
  for (const r of rows) {
    if (r.currency !== currency) {
      if (r.acceptedQuoteMinor !== null) otherCurrency += 1;
    } else if (r.acceptedQuoteMinor !== null) {
      cited += 1;
      acceptedQuoteMinor += r.acceptedQuoteMinor;
    }
    if (r.maintenance) {
      plans += 1;
      if (!r.maintenance.accepted) notAccepted += 1;
      const ends = r.maintenance.endsOn;
      if (ends) {
        if (ends < today) {
          if (r.maintenance.accepted) lapsed += 1;
        } else if (nextEndsOn === null || ends < nextEndsOn) {
          nextEndsOn = ends;
        }
      }
    }
  }
  return { projects: rows.length, cited, acceptedQuoteMinor, otherCurrency, maintenance: { plans, notAccepted, lapsed, nextEndsOn } };
}

/** One line for the maintenance tile: what stands, what needs a decision. */
export function maintenanceSentence(m: CommercialSummary['maintenance']): { value: string; caption: string } {
  if (m.plans === 0) return { value: 'No plan', caption: 'No project carries a maintenance plan' };
  const parts: string[] = [];
  if (m.lapsed > 0) parts.push(`${m.lapsed} ended: renewal due`);
  if (m.notAccepted > 0) parts.push(`${m.notAccepted} not accepted yet`);
  if (parts.length === 0) parts.push(m.nextEndsOn ? `next ends ${m.nextEndsOn}` : 'all accepted, no end date');
  return { value: `${m.plans} plan${m.plans === 1 ? '' : 's'}`, caption: parts.join(' · ') };
}
