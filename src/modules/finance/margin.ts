/**
 * Margin on the project report — the arithmetic, pure and dependency-free
 * so the test pins it. Decision: reversed by the owner on 2026-09-29;
 * time costed per person by decision E2 of 2026-09-30.
 *
 *   margin = paid revenue − (expenses recorded + AI cost + time cost)
 *
 * Cash basis: what has been PAID, not what has been invoiced. Time cost is
 * every logged hour priced at the rate in force for its person on the day
 * of the log (`projects.time_log_costs`), in paise. Hours with no rate on
 * their day are NOT priced at zero and hidden — they are carried as
 * `uncostedHours` so the screen and the CSV say "N h uncosted — no rate
 * on those days" beside the figure.
 */

export type MarginInputs = {
  paidMinor: number;
  expensesMinor: number;
  aiCostMinor: number;
  /** Logged hours × the rate in force on each log's day, in paise. */
  timeCostMinor: number;
  /** Hours logged on days no rate covered — reported, never treated as zero cost. */
  uncostedHours: number;
};

export type Margin = MarginInputs & {
  costMinor: number;
  marginMinor: number;
  /** Margin as a share of paid revenue (one decimal), or null when nothing has been paid. */
  marginPercent: number | null;
  label: 'cash-basis estimate';
};

export const MARGIN_LABEL = 'cash-basis estimate' as const;

export function computeMargin(inputs: MarginInputs): Margin {
  const costMinor = inputs.expensesMinor + inputs.aiCostMinor + inputs.timeCostMinor;
  const marginMinor = inputs.paidMinor - costMinor;
  const marginPercent = inputs.paidMinor > 0 ? Math.round((marginMinor / inputs.paidMinor) * 1000) / 10 : null;
  return { ...inputs, costMinor, marginMinor, marginPercent, label: MARGIN_LABEL };
}
