import { timelineBandFor } from './quotation-standards';

/**
 * Round 4, Quotation Master: a timeline objection is recalculated (P1-QUOTE-057, §11.2 "timeline -> recalc").
 *
 * Pure and deterministic, no model. It compares the weeks the client asked for with the estimate the quotation carries (its stated timeline, else the corpus band for
 * its price) and answers one of three things, with the options a person can take. It NEVER invents a price, a discount or a promise: whether a faster build is
 * possible, and at what cost, is the owner's decision (ADM-96, ADM-07); the options name that decision, they do not make it. The clock starts at the advance and the
 * inputs (TIMELINE_TERMS), and every verdict says so.
 */
export type TimelineVerdict = 'fits' | 'tight' | 'does_not_fit';
export type TimelineEstimate = { min: number; max: number };

export function estimateFor(statedWeeks: { min?: unknown; max?: unknown } | null | undefined, totalMinor: number): TimelineEstimate {
  const min = Number(statedWeeks?.min);
  const max = Number(statedWeeks?.max);
  if (Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min && max <= 104) return { min, max };
  const band = timelineBandFor(totalMinor);
  return { min: band.weeksMin, max: band.weeksMax };
}

export type TimelineRecalc = { askedWeeks: number; estimate: TimelineEstimate; verdict: TimelineVerdict; options: string[] };

const CLOCK = 'The clock starts once the advance payment and the required inputs (content, access, credentials) have arrived.';

export function recalculateTimeline(input: { askedWeeks: number; estimate: TimelineEstimate }): TimelineRecalc {
  const { askedWeeks: asked, estimate } = input;
  if (!Number.isInteger(asked) || asked < 1 || asked > 104) throw new Error('timeline recalculation: the asked time must be a whole number of weeks between 1 and 104');
  if (estimate.min < 1 || estimate.max < estimate.min) throw new Error('timeline recalculation: the estimate must run from a first week to a later or equal last week');

  if (asked >= estimate.max) {
    return {
      askedWeeks: asked,
      estimate,
      verdict: 'fits',
      options: [
        `The estimate of ${estimate.min}-${estimate.max} weeks already fits inside the ${asked} weeks asked. Say so plainly; the quotation does not change.`,
        CLOCK,
      ],
    };
  }
  if (asked >= estimate.min) {
    return {
      askedWeeks: asked,
      estimate,
      verdict: 'tight',
      options: [
        `${asked} weeks is inside the estimate (${estimate.min}-${estimate.max}) but only at its short end. Do not promise ${asked} unconditionally: it holds only if the client's inputs and feedback arrive on time.`,
        `Offer to deliver the core scope within ${asked} weeks and the rest after it, as a revised quotation version with its own timeline.`,
        CLOCK,
      ],
    };
  }
  return {
    askedWeeks: asked,
    estimate,
    verdict: 'does_not_fit',
    options: [
      `${asked} weeks is shorter than the shortest estimate (${estimate.min} weeks). Explain what the estimate depends on rather than agreeing to it.`,
      `Phase the scope: deliver the core within ${asked} weeks and the remainder afterwards, as a revised quotation version with its own price and timeline.`,
      'Ask the owner whether a faster build is possible. Any extra cost or resourcing is the owner\'s decision; nothing is priced or promised here.',
      CLOCK,
    ],
  };
}
