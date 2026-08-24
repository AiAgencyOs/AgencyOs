/**
 * What the agency's own formula says a scope like this costs — G-168.
 *
 * `PRICING_KNOWLEDGE` carries the corpus formula as PROSE, inside the
 * model's prompt. That means nothing has ever checked the model's number
 * against it: the formula could be followed, ignored, or half-remembered and
 * the draft would look identical either way. This module is the formula in
 * CODE, so the two can be compared.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY NOT THE DAY-RATE FLOOR THE STUDY ASKED FOR
 *
 * The corpus study's §16 proposed blocking any draft implying under
 * ₹2,000 per developer-day against its own timeline band. Measured against
 * this engine, that control is vacuous, and the reason is structural:
 * `timelineBandFor` derives the timeline FROM the price, so the implied
 * day-rate is a function of price alone and never sees scope at all.
 *
 *   · OTT (a Netflix-class platform quoted at ₹50,000) and NearServe (a
 *     three-role marketplace at ₹50,000) imply the IDENTICAL ₹1,667/day.
 *     The floor cannot separate them — and OTT was the document it was
 *     proposed to catch.
 *   · ₹50,000 is the corpus's modal price (9/45) and trips at ₹1,667/day,
 *     so the floor would refuse the agency's most common quotation.
 *   · It is not even monotonic: ₹49,999 implies ₹3,333/day and ₹50,000
 *     implies ₹1,667/day, because the band steps 3–6wk → 6–9wk. A guard
 *     that halves its own measure when the price rises by one rupee cannot
 *     be explained to the person it is guarding.
 *
 * What actually separates OTT from NearServe is the LANE: OTT is Lane 3
 * scope sold at the Lane 1 anchor. So the reference is computed by lane,
 * from the scope the model actually wrote, and the DELTA is the signal.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ADVISORY, NEVER BLOCKING, AND NEVER CLIENT-FACING
 *
 * Two rules this module refuses to break. It does not decide a price —
 * ADM-96 and ADM-07 put that with the owner, and a control that overrides
 * them has quietly moved the decision into code. And it reads PROSE with
 * regexes, which is a genuinely lossy way to count surfaces; a false
 * positive that blocked a draft would fail the whole job for a guess
 * (G-164's lesson, paid for in production).
 *
 * So the output is a number and its derivation, shown to the OWNER on the
 * copy that already says NOT YET APPROVED, and to nobody else.
 */

/** The formula's own constants — every one traceable to PRICING_KNOWLEDGE. */
const BASE_ONE_SYSTEM = 50_000;
const PER_EXTRA_SURFACE = 10_000;
const DEPTH_MULTIPLIER = { basic: 1.0, standard: 1.1, full: 1.4 } as const;
const ADD_API_READY = 25_000;
const ADD_LIVE_INTEGRATION = 30_000;
const ADD_REAL_MONEY = 25_000;
const ADD_NATIVE_IOS = 40_000;
/** Lane 3 is priced PER SURFACE, not per lever — the corpus's own shape. */
const ENTERPRISE_PER_SURFACE = { standard: 82_500, full: 142_500 } as const;
const LANE0_CEILING = 35_000;

export type Depth = keyof typeof DEPTH_MULTIPLIER;

export interface LaneReference {
  lane: 0 | 2 | 3;
  /** Whole rupees, rounded to the nearest ₹5,000 as every corpus headline is. */
  referenceRupees: number;
  surfaces: number;
  depth: Depth;
  /** The derivation, in the order it was applied — shown, never summarised. */
  basis: readonly string[];
}

// ── reading a scope, which is prose ────────────────────────────────────────

/**
 * A line that names something a person opens. "Customer app", "Admin panel",
 * "Vendor portal", "Ordering website" are surfaces; "Backend, APIs and
 * database", "Testing and deployment", "UI/UX design" are not — they are the
 * work that makes a surface, and counting them would double the estimate.
 */
const SURFACE = /\b(?:app|application|panel|portal|dashboard|website|web\s?app|site|console|storefront)\b/i;
const NOT_A_SURFACE =
  /(?:\bbackend\b|\bapis?\b|\bdatabase\b|\binfrastructure\b|\bdeployment\b|\btesting\b|\bqa\b|\bdesign\b|\bintegrations?\b|\bhosting\b|\bdocumentation\b|\bhandover\b|\btraining\b|\bsupport\b|ui\/ux|\bprototype\b|\bwireframes?\b|\barchitecture\b|\bsetup\b|\bstructure\b|\bmigration\b)/i;

const FULL_DEPTH = /\b(?:premium|enterprise|advanced|full[-\s]featured|complete\s+platform|white[-\s]label)\b/i;
const BASIC_DEPTH = /\b(?:mvp|basic|minimum\s+viable|starter|pilot|proof\s+of\s+concept)\b/i;

const PAYMENT = /\b(?:razorpay|stripe|cashfree|payu|paytm|payment\s+gateway|upi\b)/i;
const READINESS = /(?:\b[a-z]+[-\s]ready\b|\bhooks?\b|\bfoundation\b|\bstructure\s+(?:only|ready)\b)/i;
const REAL_MONEY = /\b(?:wallet|deposits?|payouts?|withdraw\w*|settlement|escrow)\b/i;
const NATIVE_IOS = /\bios\b/i;
const SAME_CODEBASE = /\b(?:flutter|react\s?native|single\s+codebase|cross[-\s]platform)\b/i;
/** The lane rule the fit uncovered: these change the LANE, not a line. */
const ENTERPRISE_SUBJECT =
  /\b(?:game|games|gaming|casino|ludo|rummy|teen\s?patti|streaming|ott|live\s+stream\w*|multiplayer|marketplace\s+operating\s+system|multi[-\s]tenant|franchise)\b/i;
const AI_SUBJECT = /\b(?:\bai\b|llm|machine\s+learning|recommendation\s+engine|chat\s?bot|voice\s+assistant)\b/i;

export interface ReferenceScope {
  items: ReadonlyArray<{ description: string; features?: readonly string[] | null }>;
}

function lineTexts(scope: ReferenceScope): string[] {
  return scope.items.map((i) => [i.description, ...(i.features ?? [])].join(' • '));
}

export function countSurfaces(scope: ReferenceScope): number {
  return scope.items.filter((i) => SURFACE.test(i.description) && !NOT_A_SURFACE.test(i.description)).length;
}

export function depthOf(scope: ReferenceScope): Depth {
  const all = lineTexts(scope).join(' ');
  if (FULL_DEPTH.test(all)) return 'full';
  if (BASIC_DEPTH.test(all)) return 'basic';
  // Standard is the middle and the honest default: the schema has no depth
  // field, so an unstated depth is not evidence of a cheap build.
  return 'standard';
}

/**
 * The reference figure, and how it was reached.
 *
 * Rounded to ₹5,000 because every headline in the corpus is round (45/45) —
 * a reference that reads ₹96,800 invites an argument about ₹800.
 */
export function laneReferenceFor(scope: ReferenceScope): LaneReference {
  const texts = lineTexts(scope);
  const all = texts.join(' ');
  const surfaces = countSurfaces(scope);
  const depth = depthOf(scope);
  const basis: string[] = [];

  const enterpriseSubject = ENTERPRISE_SUBJECT.test(all) || AI_SUBJECT.test(all);

  // ── Lane 3 — priced per surface, and reached by SUBJECT or by size ──
  if (enterpriseSubject || surfaces >= 5) {
    const perSurface = ENTERPRISE_PER_SURFACE[depth === 'basic' ? 'standard' : depth];
    const billable = Math.max(surfaces, 2);
    basis.push(
      enterpriseSubject
        ? 'Lane 3 — a game, streaming or AI-heavy subject is an enterprise conversation, not an extra line'
        : `Lane 3 — ${surfaces} surfaces is enterprise size`,
      `${billable} surface(s) × ₹${perSurface.toLocaleString('en-IN')} at ${depth} depth`,
    );
    return { lane: 3, referenceRupees: round5k(billable * perSurface), surfaces, depth, basis };
  }

  // ── Lane 0 — one surface, no live integration ──
  const hasLiveIntegration = PAYMENT.test(all) && !READINESS.test(all);
  if (surfaces <= 1 && !hasLiveIntegration && !REAL_MONEY.test(all)) {
    basis.push('Lane 0 — one surface, no live third-party integration (the owner’s ₹20,000–₹35,000 rule)');
    return { lane: 0, referenceRupees: LANE0_CEILING, surfaces, depth, basis };
  }

  // ── Lane 2 — the calculator ──
  let total = BASE_ONE_SYSTEM;
  basis.push(`₹${BASE_ONE_SYSTEM.toLocaleString('en-IN')} — one complete system (a client surface plus its admin)`);

  const extra = Math.max(0, surfaces - 2);
  if (extra > 0) {
    total += extra * PER_EXTRA_SURFACE;
    basis.push(`+ ₹${(extra * PER_EXTRA_SURFACE).toLocaleString('en-IN')} — ${extra} surface(s) beyond two`);
  }

  const multiplier = DEPTH_MULTIPLIER[depth];
  if (multiplier !== 1) {
    total = Math.round(total * multiplier);
    basis.push(`× ${multiplier} — ${depth} depth`);
  }

  if (READINESS.test(all)) {
    total += ADD_API_READY;
    basis.push(`+ ₹${ADD_API_READY.toLocaleString('en-IN')} — API-ready / hooks`);
  }
  if (hasLiveIntegration) {
    total += ADD_LIVE_INTEGRATION;
    basis.push(`+ ₹${ADD_LIVE_INTEGRATION.toLocaleString('en-IN')} — live third-party integration`);
  }
  if (REAL_MONEY.test(all)) {
    total += ADD_REAL_MONEY;
    basis.push(`+ ₹${ADD_REAL_MONEY.toLocaleString('en-IN')} — real-money mechanics`);
  }
  // iOS via the same Flutter build is +₹0 — a genuinely-included line priced
  // zero, exactly as this agency has always done. Only a SEPARATE native
  // deliverable costs, and the codebase words are how the corpus says so.
  if (NATIVE_IOS.test(all) && !SAME_CODEBASE.test(all)) {
    total += ADD_NATIVE_IOS;
    basis.push(`+ ₹${ADD_NATIVE_IOS.toLocaleString('en-IN')} — native iOS as a separate deliverable`);
  }

  return { lane: 2, referenceRupees: round5k(total), surfaces, depth, basis };
}

function round5k(n: number): number {
  return Math.round(n / 5_000) * 5_000;
}

/**
 * The note the OWNER reads beside a quotation awaiting their decision, or
 * null when the proposal sits close enough to the formula to say nothing.
 *
 * Silence is the common case on purpose. A note that appears on every
 * quotation is a note nobody reads by the third one, so the threshold is
 * deliberately loose: the formula's own fit against the corpus had a median
 * error of 17.5%, and flagging inside its own error bar would be flagging
 * noise. 30% is comfortably outside it.
 */
const NOTICEABLE = 0.3;

export function pricingNoteFor(input: {
  proposedRupees: number;
  scope: ReferenceScope;
}): string | null {
  if (input.proposedRupees <= 0) return null;
  const ref = laneReferenceFor(input.scope);
  if (ref.referenceRupees <= 0) return null;

  const delta = (input.proposedRupees - ref.referenceRupees) / ref.referenceRupees;
  if (Math.abs(delta) < NOTICEABLE) return null;

  const direction = delta < 0 ? 'below' : 'above';
  const pct = Math.round(Math.abs(delta) * 100);
  const money = (n: number) => `₹${n.toLocaleString('en-IN')}`;

  return [
    `FOR THE APPROVER ONLY — not shown to the client.`,
    `This draft is ${money(input.proposedRupees)}. The agency's own formula reads ${money(ref.referenceRupees)} for this shape — ${pct}% ${direction}.`,
    `How that figure was reached: ${ref.basis.join('; ')}.`,
    `The formula is a reference fitted to 24 past quotations (median error 17.5%), not a rule. The price is yours to set.`,
  ].join(' ');
}
