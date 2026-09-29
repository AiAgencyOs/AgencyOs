/**
 * Margin on the project report — the arithmetic, pure and dependency-free
 * so the test pins it. Decision: reversed by the owner on 2026-09-29.
 *
 *   margin = paid revenue − (expenses recorded + AI cost)
 *
 * Cash basis: what has been PAID, not what has been invoiced. Time is not
 * costed — `timeCosted` is carried so the screen can say why (no cost-rate
 * column exists anywhere in the schema), never to change the sum.
 */

export type MarginInputs = {
  paidMinor: number;
  expensesMinor: number;
  aiCostMinor: number;
  /** True when a cost rate exists to turn logged hours into money. Always false today. */
  timeCosted: boolean;
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
  const costMinor = inputs.expensesMinor + inputs.aiCostMinor;
  const marginMinor = inputs.paidMinor - costMinor;
  const marginPercent = inputs.paidMinor > 0 ? Math.round((marginMinor / inputs.paidMinor) * 1000) / 10 : null;
  return { ...inputs, costMinor, marginMinor, marginPercent, label: MARGIN_LABEL };
}
