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
 */
export const PRICING_KNOWLEDGE = [
  'HOW THIS AGENCY PRICES, from 45 of its own quotations — bands to reason inside, never a rate card:',

  'ANCHORS. Nothing has ever been quoted below ₹25,000 (the observed floor, 1/45; nothing at or',
  'under ₹20,000 in the whole corpus). ₹25,000–₹35,000 is the simple-work band: enhancements to an',
  'existing system, budget-capped utilities (4/45). ₹50,000 is the modal complete-system price —',
  'it has bought an app plus its admin panel, a dual-app ERP, a three-role marketplace (9/45).',
  'Above that: ₹75,000 recurs (4-5/45), the median headline is about ₹1,15,000, and full/premium',
  'builds enter at ₹1,25,000–₹1,70,000. The standalone ceiling observed is ₹4,75,000.',

  'WHAT MOVES A PRICE — the five levers the corpus shows, with their observed increments:',
  '(1) each extra surface (another app, another panel, another role) adds ₹10,000–₹40,000;',
  '(2) deepening the same modules between a basic and a full build roughly DOUBLES each line;',
  '(3) the integration ladder — manual process, then hooks/API-ready, then live third-party',
  'integrations — has stepped one build ₹95,000 → ₹1,70,000 → ₹3,25,000; a hooks bundle has gone',
  'for ₹18,000 and a live-integration bundle for ₹42,000;',
  '(4) real-money mechanics (wallets, games, payouts) push totals to ₹1,65,000–₹2,25,000;',
  '(5) AI feature blocks are discrete chunks at ₹50,000–₹1,00,000 each.',

  'LINE SHAPES the corpus prices: a complete website or app WITH its admin at ₹50,000 flat; an',
  'admin panel alone ₹3,500–₹38,000 scaling with depth; a backend line ₹5,000–₹55,000; mobile',
  'apps added to a web build +₹50,000; iOS delivered via the same Flutter build has gone at +₹0',
  '(a genuinely-included line priced zero is honest — the corpus does it).',

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
