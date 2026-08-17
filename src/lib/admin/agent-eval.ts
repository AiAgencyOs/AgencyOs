/**
 * Pure derivations for the agent-status view — no next/headers, no server-only,
 * so they are directly unit-testable and carry the read-only "would this agent
 * run?" logic in one checkable place.
 *
 * "Would run" is a presentation of gates the DB already enforces, never a new
 * gate: an agent runs only when it is enabled AND a provider is configured to
 * serve its model. A disabled agent, or a deployment with no ANTHROPIC_API_KEY,
 * would not — which is exactly the ADM-82 / provider posture the registry holds.
 */

export type AgentGateInput = {
  enabled: boolean;
  defaultModel: string | null;
};

export function wouldRun(agent: AgentGateInput, providerConfigured: boolean): boolean {
  return agent.enabled && providerConfigured && Boolean(agent.defaultModel && agent.defaultModel.trim());
}

/** Why an agent would not run, for the operator — never invents; reads the gates. */
export function whyNotRun(agent: AgentGateInput, providerConfigured: boolean): string | null {
  if (wouldRun(agent, providerConfigured)) return null;
  if (!agent.enabled) return 'disabled';
  if (!providerConfigured) return 'no AI provider configured';
  if (!agent.defaultModel || !agent.defaultModel.trim()) return 'no default model set';
  return 'not runnable';
}

/** A max cost ceiling in minor units, as a major-unit amount. Null stays null. */
export function formatCostMinor(minor: number | null): string | null {
  if (minor === null || Number.isNaN(minor)) return null;
  return (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
