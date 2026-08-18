/**
 * Usage & cost aggregation — pure, so the arithmetic is tested without a
 * database. It sums ONLY what the runtime actually recorded (ai.agent_runs
 * tokens, ai.agent_steps cost) — there is no estimate, no rate card, no invented
 * number here. When nothing has run, the result is empty and the page says so;
 * it never manufactures a figure to look busy.
 */

export type RunRow = { agent_key: string; input_tokens: number; output_tokens: number };
/** A step's cost, with the agent it belongs to resolved from its run. */
export type StepRow = { cost_minor: number; agent_key: string | null };

export type AgentUsage = {
  agentKey: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
};

export type UsageTotals = { runs: number; inputTokens: number; outputTokens: number; costMinor: number };

export function aggregateUsage(runs: readonly RunRow[], steps: readonly StepRow[]): {
  perAgent: AgentUsage[];
  totals: UsageTotals;
} {
  const byAgent = new Map<string, AgentUsage>();
  const get = (key: string): AgentUsage => {
    let u = byAgent.get(key);
    if (!u) {
      u = { agentKey: key, runs: 0, inputTokens: 0, outputTokens: 0, costMinor: 0 };
      byAgent.set(key, u);
    }
    return u;
  };

  for (const r of runs) {
    const u = get(r.agent_key);
    u.runs += 1;
    u.inputTokens += r.input_tokens;
    u.outputTokens += r.output_tokens;
  }

  // Cost lives on steps; attribute each to the agent of its run. A step whose
  // run could not be resolved is counted in the totals but not misattributed to
  // any agent (its agent_key is null) — honest over tidy.
  let unattributedCost = 0;
  for (const s of steps) {
    if (s.agent_key) get(s.agent_key).costMinor += s.cost_minor;
    else unattributedCost += s.cost_minor;
  }

  const perAgent = [...byAgent.values()].sort((a, b) => b.costMinor - a.costMinor || b.runs - a.runs);
  const totals: UsageTotals = {
    runs: perAgent.reduce((n, a) => n + a.runs, 0),
    inputTokens: perAgent.reduce((n, a) => n + a.inputTokens, 0),
    outputTokens: perAgent.reduce((n, a) => n + a.outputTokens, 0),
    costMinor: perAgent.reduce((n, a) => n + a.costMinor, 0) + unattributedCost,
  };

  return { perAgent, totals };
}
