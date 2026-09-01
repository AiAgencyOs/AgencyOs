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
import { pricingNoteFor } from './pricing-reference';
import { productionCostNoteFor, type StoredProductionCost } from './production-cost';

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

/**
 * What the approver is told when a STATED timeline leaves the band the price
 * implies — G-177, and silence is the common case on purpose.
 *
 * A note that appears on every quotation is a note nobody reads by the third
 * one, so this says nothing while the stated weeks overlap the corpus band at
 * all. It speaks only when the two do not touch: the agency has committed to
 * something its own 45 quotations say is fast for this money, or slow for it.
 *
 * Both directions are worth a sentence and neither is an error. Faster than the
 * band is a promise somebody has to keep; slower is a quotation that may lose
 * on delivery date. The owner decides; this only makes sure they decided
 * knowingly, which is the same posture `pricingNoteFor` takes about price.
 */
export function timelineNoteFor(input: {
  totalMinor: number;
  statedWeeks: { min: number; max: number } | null;
}): string | null {
  const stated = input.statedWeeks;
  if (!stated || !Number.isFinite(stated.min) || !Number.isFinite(stated.max)) return null;
  if (stated.min > stated.max) return null;

  const band = timelineBandFor(input.totalMinor);
  // Overlapping at all is agreement enough. Demanding containment would flag
  // a 6–8 week promise against a 6–9 week band, which is noise.
  const overlaps = stated.min <= band.weeksMax && stated.max >= band.weeksMin;
  if (overlaps) return null;

  const faster = stated.max < band.weeksMin;
  return [
    `FOR THE APPROVER ONLY — not shown to the client.`,
    `This quotation promises ${stated.min}–${stated.max} weeks.`,
    `At this price the agency's own 45 quotations sit at ${band.weeksMin}–${band.weeksMax} weeks —`,
    faster
      ? `so this is a faster commitment than anything in that history, and somebody has to keep it.`
      : `so this is slower than the price would suggest, which is a reason a client may go elsewhere.`,
    `The timeline is yours to set; this only says it is not the usual one.`,
  ].join(' ');
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

/**
 * Validity — 15 days, the corpus modal (12 of the 39 quotations that print
 * one; the rest spread across 7, 10, 14, 21 and 30, and six printed none at
 * all). Already applied at draft time by `quotationValidUntil()`; named here
 * so the number has one home rather than two.
 */
export const VALIDITY_DAYS = 15;

/**
 * The four clauses the corpus effectively did not have — G-167, study §10.
 *
 * Counted across 45 quotations: a cancellation position in 1, a refund
 * position in 1, a liability cap in 1, a stated jurisdiction in 3, and no
 * definition anywhere of when a milestone is DEEMED accepted. On a
 * ₹19,75,000 engagement that last one is the difference between "delivered"
 * and "still waiting for sign-off" being a fact or an opinion.
 *
 * These are SET, not observed — the corpus is the evidence that they were
 * missing, not the source of their wording. Each says the least a sentence
 * can say and still settle the question, because a quotation is not the
 * place to litigate and a clause nobody reads protects nobody.
 */
export const COMMERCIAL_TERMS: readonly string[] = [
  `This quotation is valid for ${VALIDITY_DAYS} days from its date.`,
  'A milestone is accepted when the demo it names is delivered and no written objection follows within 5 working days.',
  'On cancellation, work delivered to the last accepted milestone is payable and the advance for work already started is not refundable.',
  'Our total liability is limited to the amount paid under this quotation.',
  'Indian law applies, and the courts at Mohali / Chandigarh have jurisdiction.',
];

/**
 * The clause a regulated build carries — study §14's sharpest finding.
 *
 * The corpus handled this WELL where it handled it at all: the casino
 * quotation put licensing squarely on the client, and all three lending
 * quotations disclaimed RBI / NBFC compliance. It then shipped a wagering
 * quotation with an operator-controlled result engine and no regulatory
 * sentence anywhere. The rule is not new — its application was the gap.
 */
export const REGULATED_CLAUSES: Readonly<Record<string, readonly string[]>> = {
  gaming: [
    'Real-money gaming is regulated and varies by state. Licensing, age-gating, and state-wise legality are the client’s responsibility.',
    'We build the software; we do not advise on whether it may lawfully be operated.',
  ],
  lending: [
    'Lending is regulated. RBI Digital Lending compliance, NBFC or LSP licensing, and all borrower-facing disclosures are the client’s responsibility.',
    'We build the software; loan capital, co-lending arrangements and regulatory approval are outside this scope.',
  ],
  health: [
    'Health data is sensitive personal data. Clinical validity, practitioner licensing and patient-consent flows are the client’s responsibility.',
    'Nothing delivered here is a medical device or a diagnostic tool.',
  ],
  payouts: [
    'Holding or paying out client funds is regulated. Payment-aggregator status, escrow arrangements and KYC obligations are the client’s responsibility.',
    'Money moves through the client’s own gateway and merchant account, never through ours.',
  ],
};

/**
 * Which regulated categories apply — the model's declaration UNION what the
 * scope's own words show.
 *
 * One-directional on purpose: this function can add a category, never remove
 * one. A model that declares `null` while writing "wallet", "deposit",
 * "payout" and "betting" gets the clause set anyway, because a compliance
 * control a model can opt out of is not a control. The cost of a false
 * positive is a paragraph the client did not need; the cost of a false
 * negative is the corpus's wagering quotation.
 */
const REGULATED_MARKERS: Readonly<Record<string, RegExp>> = {
  gaming: /\b(?:bet|bets|betting|wager|wagering|casino|rummy|teen\s?patti|andar\s?bahar|aviator|prediction\s+game|payout\s+ratio|house\s+edge|real[-\s]money)\b/i,
  lending: /\b(?:loan|loans|lending|emi|credit\s+bureau|cibil|nbfc|disburs\w*|borrower|interest\s+rate)\b/i,
  health: /\b(?:patient|patients|clinic|clinical|diagnos\w*|prescription|doctor|medical\s+record|telemedicine|therapy|mental\s+health)\b/i,
  payouts: /\b(?:payout|payouts|withdraw\w*|settlement|escrow|wallet\s+balance|cash\s?out|remit\w*)\b/i,
};

export function regulatedCategoriesFor(input: {
  declared?: string | null;
  text: string;
}): readonly string[] {
  const found = new Set<string>();
  if (input.declared && REGULATED_CLAUSES[input.declared]) found.add(input.declared);
  for (const [category, marker] of Object.entries(REGULATED_MARKERS)) {
    if (marker.test(input.text)) found.add(category);
  }
  // Stable order, so the same quotation renders the same clauses in the same
  // sequence — the determinism the whole renderer is built on.
  return Object.keys(REGULATED_CLAUSES).filter((c) => found.has(c));
}

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
  /**
   * The priced lines themselves (G-167, widened by G-168). Two things read
   * them: the regulated-category backstop, which looks at the quotation's own
   * words rather than trusting a declaration, and the pricing reference,
   * which counts surfaces. Omitted, both still see the document's prose;
   * they simply see less.
   */
  scopeItems?: ReadonlyArray<{
    description: string;
    features?: readonly string[] | null;
    kind?: 'surface' | 'foundation' | null;
  }>,
): {
  understanding: string | null;
  exclusions: readonly string[] | null;
  assumptions: readonly string[] | null;
  clientResponsibilities: readonly string[] | null;
  dependencies: readonly string[] | null;
  acceptanceCriteria: readonly string[] | null;
  optionalAddons: ReadonlyArray<{ label: string; priceRupees: number }> | null;
  theme: string | null;
  regulatedClauses: readonly string[] | null;
  commercialTerms: readonly string[];
  /** G-168 — approver-only; the renderer draws it on nothing a client sees. */
  internalNote: string | null;
  /** G-178 — "Customer — browses the menu, orders ahead and pays". */
  roleLines: readonly string[] | null;
  /** G-178 — the third-party services, each saying whose bill it is. */
  integrationLines: readonly string[] | null;
  /** G-169 — "Phase 3 of 7", or null for a single-shot quotation. */
  phaseLabel: string | null;
  /** G-169 — what this phase does not include, and which phase owns it. */
  deferredLines: readonly string[] | null;
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

  /**
   * The timeline: STATED beats derived — G-177.
   *
   * `timelineBandFor` is a function of the price alone, which made the
   * timeline the one field of a quotation nobody could change. An owner
   * writing *"timeline 25 days se 20 days"* on a revision was silently
   * ignored, because there was no field for the reviser to write it into.
   *
   * The same order of authority G-169 gave surfaces and depth: when the
   * document says, the document wins; when it does not, the corpus band
   * answers exactly as before. So every quotation drafted before this field
   * existed renders identically, and an approved one keeps the timeline it
   * was approved with rather than acquiring a new one when the price band
   * moves underneath it.
   *
   * The stored value is checked here as well as at the write. It has been
   * through a jsonb column, and a `min` above its `max` would print a
   * backwards range at a client — cheap to refuse, and the fallback is a
   * band that is never wrong.
   */
  const stated = doc.timelineWeeks ?? null;
  const usable =
    stated !== null &&
    Number.isFinite(stated.min) &&
    Number.isFinite(stated.max) &&
    stated.min >= 1 &&
    stated.min <= stated.max;
  const band = usable
    ? { weeksMin: Math.round(stated.min), weeksMax: Math.round(stated.max) }
    : timelineBandFor(totalMinor);

  const items = scopeItems ?? [];
  const scopeText = items
    .map((i) => [i.description, ...(i.features ?? [])].join(' '))
    .join(' ');

  const categories = regulatedCategoriesFor({
    declared: doc.regulatedCategory ?? null,
    text: [doc.understanding ?? '', ...(doc.exclusions ?? []), scopeText].join(' '),
  });
  const regulatedClauses = categories.flatMap((c) => REGULATED_CLAUSES[c] ?? []);

  // G-169 — the phase this quotation is, and what it hands to a later one.
  // A deferral is not an exclusion: it names the phase that owns the item,
  // which is what turns "why isn't X there?" into "X is phase 5".
  const phase = doc.phase ?? null;
  const phaseLabel = phase ? `Phase ${phase.number} of ${phase.of}` : null;
  const deferredLines =
    phase && Array.isArray(phase.deferredTo) && phase.deferredTo.length > 0
      ? phase.deferredTo.map((d) => `${d.item} — phase ${d.phase}`)
      : null;

  // G-168 — the formula's own reading of this shape, for the approver only.
  // Computed here so every door gets it identically; the renderer refuses to
  // draw it on anything a client could receive.
  const pricingNote =
    items.length > 0
      ? pricingNoteFor({
          proposedRupees: Math.round(totalMinor / 100),
          scope: { items, depth: (doc.depth as 'basic' | 'standard' | 'full' | undefined) ?? null },
        })
      : null;

  // G-177. Two independent things the approver may want to know about one
  // quotation, joined rather than nested: either can be silent, and a
  // quotation with neither still shows no approver block at all.
  const timelineNote = timelineNoteFor({
    totalMinor,
    statedWeeks: usable ? { min: band.weeksMin, max: band.weeksMax } : null,
  });
  /**
   * G-179 — what it costs to make, against what the draft asks for it.
   *
   * Read from the FROZEN block rather than recomputed: the rates behind it
   * are editable from a settings page, so a note computed now would judge an
   * August quotation by today's costs. Silent above the owner's own minimum
   * band, which is the common case.
   */
  const costNote = productionCostNoteFor({
    proposedRupees: Math.round(totalMinor / 100),
    cost: (doc.productionCost as StoredProductionCost | null | undefined) ?? null,
  });

  const notes = [costNote, pricingNote, timelineNote].filter((n): n is string => Boolean(n));
  const internalNote = notes.length > 0 ? notes.join('\n\n') : null;

  /**
   * Who uses it, and what it stands on — G-178.
   *
   * Composed here rather than in the renderer for the same reason every other
   * line is: the assembler owns policy, the renderer owns the page, and a
   * sentence built in the drawer is a sentence no test can read without
   * rendering a PDF.
   */
  const roleLines =
    Array.isArray(doc.roles) && doc.roles.length > 0
      ? doc.roles
          .filter((r) => typeof r?.name === 'string' && typeof r?.whatTheyDo === 'string')
          .map((r) => `${r.name} — ${r.whatTheyDo}`)
      : null;

  const integrations = Array.isArray(doc.integrations)
    ? doc.integrations.filter((i) => typeof i?.name === 'string' && typeof i?.purpose === 'string')
    : [];
  const integrationLines =
    integrations.length > 0
      ? [
          ...integrations.map((i) => {
            // Whose bill it is comes FIRST after the purpose, because it is
            // the part that causes the argument. A charge, when the
            // requirements established one, follows it — and nothing is
            // invented when they did not.
            const bill =
              i.whoPays === 'included'
                ? 'Included in this price.'
                : 'Billed to you directly by the provider, and not part of this price.';
            const charge = typeof i.charge === 'string' && i.charge.trim() ? ` ${i.charge.trim()}` : '';
            return `${i.name} — ${i.purpose} ${bill}${charge}`;
          }),
          // Said once, plainly, whenever any of them is the client's. The
          // corpus's own disputes are full of this: a fixed price that turned
          // out to exclude the gateway's percentage, discovered at go-live.
          ...(integrations.some((i) => i.whoPays === 'client')
            ? ['These third-party accounts are opened in your name; their fees and any changes to them are outside this quotation.']
            : []),
        ]
      : null;

  return {
    understanding: doc.understanding ?? null,
    roleLines,
    integrationLines,
    exclusions: doc.exclusions ?? null,
    assumptions: doc.assumptions ?? null,
    clientResponsibilities: doc.clientResponsibilities ?? null,
    dependencies: doc.dependencies ?? null,
    acceptanceCriteria: doc.acceptanceCriteria ?? null,
    optionalAddons:
      (doc.optionalAddons as ReadonlyArray<{ label: string; priceRupees: number }> | null | undefined) ?? null,
    theme: doc.industryTheme ?? null,
    regulatedClauses: regulatedClauses.length > 0 ? regulatedClauses : null,
    commercialTerms: COMMERCIAL_TERMS,
    internalNote,
    phaseLabel,
    deferredLines,
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
