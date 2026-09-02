/**
 * Usage & cost aggregation — pure, so the arithmetic is tested without a
 * database. It sums ONLY what the runtime actually recorded — there is no
 * estimate, no rate card and no invented number here. When nothing has run,
 * the result is empty and the page says so; it never manufactures a figure to
 * look busy.
 *
 * ── one aggregator, from one source — G-186 ───────────────────────────────
 *
 * There were two shapes here: run rows for tokens and step rows for cost,
 * added up in the application from every row ever recorded, under a
 * 10,000-row cap that turned a partial total into "the total". The rollup
 * table answers the same question already summed, so the run/step aggregator
 * is gone rather than left beside it — two ways to compute one money figure is
 * two figures that can disagree, and the one nobody reads is the one that
 * drifts.
 */

/**
 * One rolled-up day, as `ai.cost_ledger` stores it — G-186.
 *
 * Already summed by the database, one row per day per agent per model.
 * Reading it means the page adds a few hundred rows instead of every run and
 * every step ever recorded.
 */
export type AgentUsage = {
  agentKey: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
};

export type UsageTotals = { runs: number; inputTokens: number; outputTokens: number; costMinor: number };

export type LedgerRow = {
  agent_key: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_minor: number;
};

/**
 * The same answer, from the rollup.
 *
 * The rollup and the step rows agree by construction — `ai.roll_up_run_cost()`
 * sums the steps — and that is checked against a real database rather than
 * assumed, because it is the claim the whole change rests on.
 */
export function aggregateLedger(rows: readonly LedgerRow[]): {
  perAgent: AgentUsage[];
  totals: UsageTotals;
} {
  const byAgent = new Map<string, AgentUsage>();
  for (const r of rows) {
    let u = byAgent.get(r.agent_key);
    if (!u) {
      u = { agentKey: r.agent_key, runs: 0, inputTokens: 0, outputTokens: 0, costMinor: 0 };
      byAgent.set(r.agent_key, u);
    }
    u.runs += r.runs;
    u.inputTokens += r.input_tokens;
    u.outputTokens += r.output_tokens;
    u.costMinor += r.cost_minor;
  }

  const perAgent = [...byAgent.values()].sort((a, b) => b.costMinor - a.costMinor || b.runs - a.runs);
  return {
    perAgent,
    totals: {
      runs: perAgent.reduce((n, a) => n + a.runs, 0),
      inputTokens: perAgent.reduce((n, a) => n + a.inputTokens, 0),
      outputTokens: perAgent.reduce((n, a) => n + a.outputTokens, 0),
      costMinor: perAgent.reduce((n, a) => n + a.costMinor, 0),
    },
  };
}
