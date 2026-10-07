/**
 * P1-CRM-045 / P1-CRM-063: the shape of `sales.p1s_commercial_report`, parsed defensively, and the one place a rate is computed. A rate is `won / (won + lost)`
 * of deals that CLOSED in the window, and it is null (never 0%) when nothing closed in that group: "no deals" and "every deal lost" are different statements.
 * Pure, so a test can call it.
 */

export type Split = { won: number; lost: number };
export type CommercialReport = {
  days: number;
  deals: { won: number; lost: number; wonValueMinor: number; avgWonValueMinor: number | null };
  discount: {
    decisions: Record<string, number>;
    takenEffectMinor: number;
    avgPct: number | null;
    discounted: Split;
    plain: Split;
  };
  trustOffer: { trust: Split; standard: Split };
  repeat: { repeat: Split; fresh: Split };
  nurture: { leads: number; converted: number };
  objections: Array<{ kind: string; raised: number; open: number; lost: number }>;
  sources: Array<{ source: string; leads: number; won: number }>;
  agents: Array<{ agent: string; runs: number; succeeded: number; failed: number; costMinor: number; avgLatencyMs: number | null }>;
};

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : n(v));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);

/** won / (won + lost), or null when nothing closed. */
export function closeRate(s: Split): number | null {
  const total = s.won + s.lost;
  return total === 0 ? null : s.won / total;
}

export function parseCommercialReport(raw: unknown): CommercialReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const deals = obj(r.deals);
  const disc = obj(r.discount);
  const trust = obj(r.trustOffer);
  const rep = obj(r.repeat);
  const nur = obj(r.nurture);
  return {
    days: n(r.days),
    deals: { won: n(deals.won), lost: n(deals.lost), wonValueMinor: n(deals.wonValueMinor), avgWonValueMinor: nn(deals.avgWonValueMinor) },
    discount: {
      decisions: Object.fromEntries(Object.entries(obj(disc.decisions)).map(([k, v]) => [k, n(v)])),
      takenEffectMinor: n(disc.takenEffectMinor),
      avgPct: nn(disc.avgPct),
      discounted: { won: n(disc.discountedWon), lost: n(disc.discountedLost) },
      plain: { won: n(disc.plainWon), lost: n(disc.plainLost) },
    },
    trustOffer: { trust: { won: n(trust.won), lost: n(trust.lost) }, standard: { won: n(trust.standardWon), lost: n(trust.standardLost) } },
    repeat: { repeat: { won: n(rep.won), lost: n(rep.lost) }, fresh: { won: n(rep.newWon), lost: n(rep.newLost) } },
    nurture: { leads: n(nur.leads), converted: n(nur.converted) },
    objections: list(r.objections).map((o) => ({ kind: String(o.kind), raised: n(o.raised), open: n(o.open), lost: n(o.lost) })),
    sources: list(r.sources).map((s) => ({ source: String(s.source), leads: n(s.leads), won: n(s.won) })),
    agents: list(r.agents).map((a) => ({ agent: String(a.agent), runs: n(a.runs), succeeded: n(a.succeeded), failed: n(a.failed), costMinor: n(a.costMinor), avgLatencyMs: nn(a.avgLatencyMs) })),
  };
}

export const REPORT_WINDOWS = [30, 90, 180, 365] as const;
