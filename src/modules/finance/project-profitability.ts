import { computeMargin, type Margin } from './margin';
import { isLiveInvoice, verifiedOn, type BasisInvoice } from './verified-basis';

/**
 * Project profitability — ONE margin definition (PDF SCR-055 "Project
 * profitability"; and the three-nets disagreement in the rendered audit).
 *
 *   margin = verified revenue − (expenses recorded + AI cost + time cost)
 *
 * Verified revenue is `invoices.verified_minor` (verified-basis.ts), the same
 * basis as the overview's Total Received, so Finance › Expenses, the project
 * report and the overview cannot disagree about a project. The org-level "Net
 * Profit" on the overview is the same thing one level up with the AI and time
 * terms left out (verified received − expenses, cash basis); this page states
 * both, each named, and never a third.
 *
 * Pure. Costs in other currencies than the project's are the caller's to keep
 * apart; AI and time cost are recorded in INR (margin-queries.ts says so).
 */

export type ProfitabilityProject = { id: string; name: string; currency: string };
export type ProjectCosts = { expensesMinor: number; aiCostMinor: number; timeCostMinor: number; uncostedHours: number };

export type ProjectProfitability = {
  projectId: string;
  name: string;
  currency: string;
  invoicedMinor: number;
  margin: Margin;
};

export function projectProfitability(input: {
  projects: readonly ProfitabilityProject[];
  invoices: readonly BasisInvoice[];
  costs: ReadonlyMap<string, ProjectCosts>;
}): ProjectProfitability[] {
  const invoiced = new Map<string, number>();
  const verified = new Map<string, number>();
  for (const i of input.invoices) {
    if (!i.project_id || !isLiveInvoice(i.status)) continue;
    invoiced.set(i.project_id, (invoiced.get(i.project_id) ?? 0) + i.total_minor);
    verified.set(i.project_id, (verified.get(i.project_id) ?? 0) + verifiedOn(i));
  }
  return input.projects
    .map((p) => {
      const c = input.costs.get(p.id) ?? { expensesMinor: 0, aiCostMinor: 0, timeCostMinor: 0, uncostedHours: 0 };
      return {
        projectId: p.id,
        name: p.name,
        currency: p.currency,
        invoicedMinor: invoiced.get(p.id) ?? 0,
        margin: computeMargin({ paidMinor: verified.get(p.id) ?? 0, ...c }),
      };
    })
    .filter((r) => r.invoicedMinor > 0 || r.margin.costMinor > 0 || r.margin.uncostedHours > 0)
    .sort((a, b) => b.margin.marginMinor - a.margin.marginMinor);
}

/** Filters for the expenses register: category, project (`none` = overhead), vendor text, inclusive date range. */
export type ExpenseFilter = { category?: string; project?: string; vendor?: string; from?: string; to?: string };

type ExpenseLike = { category: string; projectId: string | null; vendor: string | null; incurredOn: string };

export function filterExpenses<T extends ExpenseLike>(rows: readonly T[], f: ExpenseFilter): T[] {
  const vendor = f.vendor?.trim().toLowerCase();
  return rows.filter((e) => {
    if (f.category && e.category !== f.category) return false;
    if (f.project === 'none' ? e.projectId !== null : f.project ? e.projectId !== f.project : false) return false;
    if (vendor && !(e.vendor ?? '').toLowerCase().includes(vendor)) return false;
    if (f.from && e.incurredOn < f.from) return false;
    if (f.to && e.incurredOn > f.to) return false;
    return true;
  });
}
