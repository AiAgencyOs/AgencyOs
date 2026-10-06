/**
 * Which model an agent runs on — the rule, with no database attached.
 *
 * SCR-064 (docs/AGENCYOS_ADMIN_REMAINING_GAPS.md, "routing grid by agent").
 * `ai.routing_policies` is per CATEGORY (ADM-84) and until now nothing bound
 * an agent to a category, so the runner reached the model through
 * `ai.agents.default_model` alone and the policies were a screen with no
 * consumer. Three things change here, all of them pure so a test can prove
 * the order rather than trust it:
 *
 *   1. every defined agent has ONE category the runner asks about, below —
 *      which of ADM-84's seven kinds of work it does. The grid on
 *      /agents/routing shows every cell, and marks this one, because an
 *      override in another cell is a record the runner never reads.
 *   2. an owner's override for (agent, category) — `ai.agent_routing_overrides`
 *      — is consulted BEFORE the category's policy.
 *   3. the category policy's admin override, then its ordered preference,
 *      come next; the agent row's `default_model` is last, and is what the
 *      runner already used, so a tenant that has set nothing runs exactly as
 *      before.
 *
 * Kept free of 'server-only' and of any import: `orderModelCandidates` is
 * called from the runner, from the routing page and from a unit test.
 */

export const ROUTING_CATEGORIES = [
  'engineering',
  'coordination',
  'client_facing',
  'extraction',
  'design',
  'money',
  'certification',
] as const;
export type RoutingCategory = (typeof ROUTING_CATEGORIES)[number];

/**
 * The category the runner asks about for each defined agent (ADM-82 roster ×
 * ADM-84 categories). An agent not listed here — the two preserved rows ADM-82
 * folded into `sales` — has no category, and the runner consults no override
 * or policy for it.
 */
export const AGENT_CATEGORY: Readonly<Record<string, RoutingCategory>> = {
  requirement_collector: 'extraction',
  orchestrator: 'coordination',
  developer: 'engineering',
  quality_assurance: 'certification',
  sales: 'client_facing',
  project_manager: 'coordination',
  project_planning: 'coordination',
  ui_designer: 'design',
  ui_prototype: 'design',
  handover: 'certification',
  finance: 'money',
  support: 'client_facing',
  customer_success: 'client_facing',
  upsell: 'money',
  // ADM-112. A new category would be a new ADM-84 decision, so these use the
  // existing ones: the Ad Manager proposes budgets (money, the tightest), and
  // the other three draft what a person outside will eventually read.
  ad_manager: 'money',
  email_outreach: 'client_facing',
  social_media: 'client_facing',
  marketplace_opportunity: 'client_facing',
  // ADM-113 (Phase 5). Engineering work routes as engineering; the independent reviewer routes as certification, the tightest.
  frontend_developer: 'engineering',
  backend_developer: 'engineering',
  database_developer: 'engineering',
  mobile_developer: 'engineering',
  integration: 'engineering',
  devops_build: 'engineering',
  test_automation: 'engineering',
  bug_fix: 'engineering',
  refactor_performance: 'engineering',
  documentation: 'engineering',
  security_review: 'certification',
  // ADM-114 (Phase 6): QA specialists route as certification, the tightest category.
  functional_test: 'certification',
  ui_journey_test: 'certification',
  api_integration_test: 'certification',
  database_test: 'certification',
  security_test: 'certification',
  performance_test: 'certification',
  compatibility_test: 'certification',
  regression_test: 'certification',
  release_readiness: 'certification',
  // ADM-115 (Phase 9): finance proposals about money route as money; the reminder DRAFT is what a client will eventually read.
  finance_reconciliation: 'money',
  finance_communication: 'client_facing',
  finance_close: 'money',
};

export function categoryForAgent(agentKey: string): RoutingCategory | null {
  return AGENT_CATEGORY[agentKey] ?? null;
}

export type RoutingInputs = {
  /** `ai.agent_routing_overrides` for (agent, category), or null when none. */
  readonly override: { readonly preferredModels: readonly string[] } | null;
  /** `ai.routing_policies` for the category, or null when never configured. */
  readonly policy: {
    readonly adminOverrideModel: string | null;
    readonly preferredModels: readonly string[];
  } | null;
  /**
   * `ai.fallback_chains` for the run's WORK CLASS (decision 2026-09-30, ADM-84
   * reversed): the owner's ordered fallbacks, consulted after the override
   * and the policy and before the default. Absent when the caller has no
   * work class in hand or the owner set none.
   */
  readonly fallbackChain?: readonly string[];
  /** `ai.agents.default_model` — always present, always last. */
  readonly agentDefault: string;
};

export type ModelSource = 'agent_override' | 'policy_override' | 'policy_preference' | 'fallback_chain' | 'agent_default';

export type ModelCandidate = { readonly model: string; readonly source: ModelSource };

/**
 * Every model that could serve this run, in the order it should be tried.
 *
 * The caller takes the first one a registered provider serves. Duplicates
 * are dropped keeping the earliest position, so a model named both by the
 * override and by the policy is still credited to the override. The work
 * class's fallback chain comes after both and before the agent's default
 * (decision 2026-09-30). The default is always the last entry, so the list
 * is never empty.
 */
export function orderModelCandidates(input: RoutingInputs): readonly ModelCandidate[] {
  const out: ModelCandidate[] = [];
  const seen = new Set<string>();
  const push = (model: string | null | undefined, source: ModelSource) => {
    const m = model?.trim();
    if (!m || seen.has(m)) return;
    seen.add(m);
    out.push({ model: m, source });
  };

  for (const m of input.override?.preferredModels ?? []) push(m, 'agent_override');
  push(input.policy?.adminOverrideModel, 'policy_override');
  for (const m of input.policy?.preferredModels ?? []) push(m, 'policy_preference');
  for (const m of input.fallbackChain ?? []) push(m, 'fallback_chain');
  push(input.agentDefault, 'agent_default');

  return out;
}

/** The model the runner would use when every candidate is served — the grid's cell. */
export function effectiveModel(input: RoutingInputs): ModelCandidate {
  const first = orderModelCandidates(input)[0];
  // orderModelCandidates always ends with the agent default, so this is only
  // reachable with an empty default — and then the honest answer is the
  // empty default itself, not a throw on a page.
  return first ?? { model: input.agentDefault, source: 'agent_default' };
}
