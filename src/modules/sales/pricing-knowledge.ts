/**
 * What this agency's own quotations say a price is — ADM-96, G-162.
 *
 * Distilled from a study of 45 real quotation PDFs this agency sent between
 * 29 Jul and 22 Aug 2026 (≈32 engagements). Every figure below was OBSERVED
 * in that corpus and carries its evidence count; nothing here is an industry
 * benchmark or a model's opinion. This is the ground ADM-96 stands on: the
 * agent may propose a price BECAUSE the proposal is drawn from how this
 * agency has actually priced, and the owner decides every number before a
 * client sees it (ADM-07 — approval is the human act now).
 *
 * Whole rupees throughout. The schema multiplies by 100 at the write, so the
 * model never touches paise — a unit an LLM slips a zero on.
 *
 * If the agency's pricing moves, this file is WHERE it moves: re-run the
 * corpus study, change the numbers here, and every future draft follows.
 * There is still no price catalog (ADM-22) — these are observed bands the
 * owner corrects per client, not rates anybody may quote from directly.
 *
 * The FORMULA section was fitted 2026-08-24 at the owner's ask ("maine
 * already 30+ quotations share kiye unhi ko analyse krke pricing formula
 * bnao"): every corpus document became an evidence-cited feature vector, and
 * a deterministic coordinate-descent fit against the 24 core-lane quotes
 * chose the increments (median error 17.5%, three exact hits). The three
 * biggest residuals are the corpus's own anchor-pull — core scope charged at
 * the ₹50,000 budget anchor — which is a decision the formula prices but
 * never makes. Full derivation and the fit table: the "BussEnhancer Pricing
 * Formula" artifact.
 */
export const PRICING_KNOWLEDGE = [
  'HOW THIS AGENCY PRICES, from 45 of its own quotations — bands to reason inside, never a rate card:',

  'ANCHORS. ₹20,000 is the agency’s stated floor for simple work — one surface, few screens, no',
  'live third-party integration. Say so plainly when you use it: it is the OWNER’S RULE, not a',
  'corpus observation, because the 45 quotations contain nothing at or under ₹20,000 and their own',
  'floor is ₹25,000 (1/45). Never cite evidence for ₹20,000; there is none yet, and the first',
  'quotation issued at it becomes its own. ₹25,000–₹35,000 is the observed simple-work band:',
  'enhancements to an existing system, budget-capped utilities (4/45).',
  '₹50,000 is the modal complete-system price —',
  'it has bought an app plus its admin panel, a dual-app ERP, a three-role marketplace (9/45).',
  'Above that: ₹75,000 recurs (4-5/45), the median headline is about ₹1,15,000, and full/premium',
  'builds enter at ₹1,25,000–₹1,70,000. The standalone ceiling observed is ₹4,75,000.',

  'THE FORMULA, fitted deterministically against 24 of the corpus’s core-lane quotes',
  '(median error 17.5%; three exact hits). First PICK THE LANE, then calculate:',
  'LANE 0 — SIMPLE (₹20,000–₹35,000, the owner’s rule): ONE client surface, a handful of screens,',
  'straightforward functionality, and NO live third-party integration — or an enhancement to a',
  'system that already exists. The guard is the scope, not the wish: a second surface or a live',
  'payment gateway means this is not Lane 0, whatever the budget says. ₹20,000 is the floor and',
  'is owner-declared; ₹25,000–₹35,000 is where the corpus’s own simple work actually sits.',
  'LANE 1 — BUDGET: the client’s stated budget is the constraint → ₹50,000 flat for a complete',
  '2-surface system (10 of 12 sub-₹70,000 quotes are exactly ₹50,000); small utilities',
  '₹30,000–₹35,000; protect the number by cutting scope, never by discounting.',
  'LANE 2 — CORE (most work, ₹70,000–₹1,75,000), the calculator:',
  'start ₹50,000 for one complete system (a client surface plus its admin);',
  'add ₹10,000 for EACH extra surface beyond two (driver app, vendor panel, second site);',
  'multiply the two rows so far by depth — basic ×1.0, standard ×1.1, full/premium ×1.4;',
  'add ₹25,000 if API-ready/hooks; add ₹30,000 if LIVE third-party integrations (a payment',
  'gateway counts); add ₹25,000 if real-money mechanics (wallet, deposits, payouts);',
  'add ₹40,000 only if native iOS is a separate deliverable — iOS via the same Flutter build',
  'is +₹0, a genuinely-included line priced zero, exactly as this agency has always done;',
  'then round to the nearest ₹5,000.',
  'LANE 3 — ENTERPRISE (₹1,65,000+): deep backends, multi-role platforms, real-money gaming,',
  'AI-heavy builds are priced PER SURFACE, not per lever — ₹75,000–₹90,000 per surface at',
  'standard depth, ₹1,20,000–₹1,65,000 per surface at full depth; above about ₹4,00,000 the',
  'corpus splits the work into a phase program at ₹2,35,000–₹3,25,000 per phase.',
  'LANE RULE the fit uncovered: games and AI blocks do NOT move core-lane prices — they change',
  'the LANE. A game-heavy or AI-heavy ask is an enterprise conversation, not an extra line.',
  'The lane itself is the owner’s call; when the requirements do not say budget, price the',
  'core lane and let the owner decide.',

  'FORM. Headlines are round: 38/40 single-price quotations end in a clean thousand. Prices are',
  'lump sums per line of work — this agency has NEVER priced per page, per screen, or per hour',
  '(0/45), so do not invent such a rate. Totals are top-down near an anchor with the lines',
  'distributed after, not bottom-up sums of parts.',

  'DISCIPLINE, each rule traced to a dispute this corpus actually shipped:',
  'never write "hooks", "API-ready", "foundation" or "-ready" in a line without saying what does',
  'NOT work at handover; never use depth words (basic, core, partial, full, simplified) without',
  'saying what they include; never leave scope open-ended inside a fixed price ("and much more");',
  'name only work the requirements support. Numbers live in the price fields ONLY — never write',
  'an amount, a percentage, or a rupee figure inside a description or the summary, because the',
  'arithmetic is checked on the fields and prose numbers are the ones that drift.',
].join(' ');
