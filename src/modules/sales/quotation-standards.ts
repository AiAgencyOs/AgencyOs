/**
 * The policy half of a quotation — G-165, the Master Quotation System's rule:
 * the MODEL writes what requires reading the requirements; CODE writes what
 * is policy. Payment families, timeline bands, the support standard, the GST
 * line and the change-request rule live here, derived from the totals at
 * render time and never stored — so a policy change never rewrites an
 * approved document, and an approved document always shows the policy that
 * was in force when it rendered (its stored sections are frozen; these are
 * functions of its frozen total).
 *
 * Every number is the corpus's (OBSERVED) or the system's set standard where
 * the corpus had none — each marked at its definition.
 */

import { parseQuotationDocument } from './schema';

/** One milestone of a payment schedule, exact to the paisa. */
export interface PaymentRow {
  label: string;
  pct: number;
  amountMinor: number;
}

export interface PaymentSchedule {
  /** 'A' 40/30/30 · 'B' 30/30/25/15 — Part G's families. */
  family: 'A' | 'B';
  rows: PaymentRow[];
}

/**
 * Part G: below ₹1,00,000 → 40/30/30 on demo events; from ₹1,00,000 →
 * 30/30/25/15 (both OBSERVED, 10/45 each, the only two real families in the
 * corpus). Triggers are demo events, never dates. The design-approval
 * milestone carries the revision cap the corpus never had (DO-NOT #12).
 *
 * Exactness is law (Part L: Σ milestones = total): every row is rounded to
 * the paisa and the LAST row absorbs the remainder, so the schedule sums to
 * the total for any amount — including ones no percentage divides cleanly.
 */
export function paymentScheduleFor(totalMinor: number): PaymentSchedule {
  const spec: { family: 'A' | 'B'; parts: { label: string; pct: number }[] } =
    totalMinor < 100_000_00
      ? {
          family: 'A',
          parts: [
            { label: 'Advance — confirmation; work starts here', pct: 40 },
            { label: 'Working-core demo', pct: 30 },
            { label: 'Delivery + source-code handover', pct: 30 },
          ],
        }
      : {
          family: 'B',
          parts: [
            { label: 'Advance — confirmation + NDA; work starts here', pct: 30 },
            { label: 'Design approval (max 2 revision rounds; further rounds are change requests)', pct: 30 },
            { label: 'UAT-ready build', pct: 25 },
            { label: 'Handover + deployment + training', pct: 15 },
          ],
        };

  const rows: PaymentRow[] = [];
  let allocated = 0;
  spec.parts.forEach((part, index) => {
    const amountMinor =
      index === spec.parts.length - 1
        ? totalMinor - allocated
        : Math.round((totalMinor * part.pct) / 100);
    allocated += amountMinor;
    rows.push({ label: part.label, pct: part.pct, amountMinor });
  });
  return { family: spec.family, rows };
}

/**
 * Part F: the corpus's own price↔duration bands (OBSERVED, 45/45 tabulated).
 * A band, never a date — the clock starts at advance + inputs, and that
 * sentence travels with the number.
 */
export function timelineBandFor(totalMinor: number): { weeksMin: number; weeksMax: number } {
  if (totalMinor < 50_000_00) return { weeksMin: 3, weeksMax: 6 };
  if (totalMinor < 100_000_00) return { weeksMin: 6, weeksMax: 9 };
  if (totalMinor < 190_000_00) return { weeksMin: 7, weeksMax: 14 };
  if (totalMinor < 300_000_00) return { weeksMin: 8, weeksMax: 12 };
  return { weeksMin: 10, weeksMax: 22 };
}

/** The sentences the timeline band travels with — fixed, both directions honest. */
export const TIMELINE_TERMS: readonly string[] = [
  'The clock starts at advance payment plus the required inputs (content, credentials, access).',
  'Client feedback within 3 working days per review; client-side delays extend the timeline proportionally.',
  'App-store review, payment-gateway activation and DNS are outside this clock.',
];

/**
 * The support standard (SET — the corpus had no rule; 30 days is its modal,
 * 19/45): what a bug is, and what it is not.
 */
export const SUPPORT_STANDARD = {
  days: 30,
  lines: [
    'Bugs — something in the included list not working as written: fixed free for 30 days after handover, business hours.',
    'A change to included scope is a change request; anything not listed is a new feature — both quoted separately.',
    'Maintenance after the window (updates, monitoring, backups) is an optional AMC, quoted on request.',
    'Third-party issues (gateway, stores, hosting, SMS) are the vendor’s to fix and ours to assist with.',
  ],
} as const;

/** Part G: named plainly, one way, every time — never hedged, never silent. */
export const GST_LINE = 'All amounts are exclusive of GST; 18% GST extra.';

/** Part E: the world closed both ways, and what a change does. */
export const SCOPE_PROTECTION_LINES: readonly string[] = [
  'Everything listed above is included. Anything not listed is out of scope.',
  'Any change to this scope — add, remove, or alter — is a change request: it produces a revised quotation version with its own price and timeline, and work on it starts after written approval.',
];

/** The closing — the thread the client received this on IS the channel. */
export const NEXT_STEPS_LINES: readonly string[] = [
  'Reply on this conversation to confirm, or to ask for changes — the quotation revises as a new version.',
  'On confirmation: advance payment, and work starts within 2–3 working days.',
  'Source code and IP transfer on final payment.',
];


/**
 * Everything the renderer needs beyond the rows — the stored judgment
 * sections plus the policy sections computed from the frozen total. Null for
 * a legacy proposal (no document): the PDF then renders exactly as it always
 * did, which is both backward compatibility and honesty — the owner approved
 * that form.
 */
export function quotationSectionsFor(
  totalMinor: number,
  taxMinor: number,
  rawDocument: unknown,
): {
  understanding: string | null;
  exclusions: readonly string[] | null;
  assumptions: readonly string[] | null;
  clientResponsibilities: readonly string[] | null;
  paymentRows: readonly PaymentRow[];
  timelineLabel: string;
  timelineTerms: readonly string[];
  supportLines: readonly string[];
  gstLine: string | null;
  scopeProtection: readonly string[];
  nextSteps: readonly string[];
} | null {
  const doc = parseQuotationDocument(rawDocument);
  if (!doc) return null;
  const band = timelineBandFor(totalMinor);
  return {
    understanding: doc.understanding ?? null,
    exclusions: doc.exclusions ?? null,
    assumptions: doc.assumptions ?? null,
    clientResponsibilities: doc.clientResponsibilities ?? null,
    paymentRows: paymentScheduleFor(totalMinor).rows,
    timelineLabel: `Estimated ${band.weeksMin}–${band.weeksMax} weeks`,
    timelineTerms: TIMELINE_TERMS,
    supportLines: SUPPORT_STANDARD.lines,
    // The review's contradiction, closed by a rule: a stored Tax row means
    // GST is already INSIDE the total, and saying "extra" beneath it would
    // let the client hold the agency to either reading. One or the other.
    gstLine: taxMinor > 0 ? null : GST_LINE,
    scopeProtection: SCOPE_PROTECTION_LINES,
    nextSteps: NEXT_STEPS_LINES,
  };
}
