import 'server-only';

import { hasConfiguredProvider } from '@/lib/ai/router';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The agent registry and provider posture, read-only, for the Admin — areas D,
 * G, N of the control-center audit.
 *
 * Deliberately READ-ONLY: the audit warned that a browser write to `ai.agents`
 * would reopen the cross-tenant break `…380000` closed (the registry is global;
 * `agents_write` is owner-only and there is no per-tenant activation model yet,
 * gated by ADM-82). So this SHOWS enabled / autonomy / model / ceilings /
 * validation and a derived "would run?", and changes nothing. `agents_select`
 * admits any internal role, and the rows carry no secret — the provider status
 * is a single boolean from `hasConfiguredProvider()`, never the key.
 */

export type AgentRow = {
  key: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  autonomyLevel: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  maxSteps: number | null;
  maxCostMinor: number | null;
  disabledReason: string | null;
  definitionVersion: string | null;
  lastValidatedAt: string | null;
};

export type AiStatus = {
  /** True when at least one provider is registered (ANTHROPIC_API_KEY present). Never the key. */
  providerConfigured: boolean;
  agents: AgentRow[];
};

export async function aiStatus(): Promise<AiStatus> {
  const providerConfigured = hasConfiguredProvider();

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('ai')
    .from('agents')
    .select(
      'key, display_name, description, enabled, autonomy_level, default_model, default_effort, max_steps, max_cost_minor, disabled_reason, definition_version, last_validated_at',
    )
    .order('key');

  // Refuse on a failed read rather than rendering an empty registry (G-054): a
  // page reporting "0 agents, nothing would run" because the DB did not answer
  // reads as "the AI is off" when it is merely unreadable. `ai.agents` always
  // has rows in a real deployment, so [] here would be a lie, not a fact.
  if (error) unreadable('aiStatus', error);

  const agents: AgentRow[] = (data ?? []).map((a) => ({
    key: a.key,
    displayName: a.display_name,
    description: a.description,
    enabled: a.enabled,
    autonomyLevel: a.autonomy_level,
    defaultModel: a.default_model,
    defaultEffort: a.default_effort,
    maxSteps: a.max_steps,
    maxCostMinor: a.max_cost_minor,
    disabledReason: a.disabled_reason,
    definitionVersion: a.definition_version,
    lastValidatedAt: a.last_validated_at,
  }));

  return { providerConfigured, agents };
}
