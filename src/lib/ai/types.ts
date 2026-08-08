import type { Result } from '@/lib/result';

/**
 * The provider port (ARCHITECTURE.md §6).
 *
 * Everything above this interface — agents, prompts, extraction — is written
 * against these types and never against a vendor SDK. Swapping or adding a
 * provider is implementing this interface and registering it in router.ts.
 *
 * The *model* is deliberately not an enum here. Model ids live in
 * `ai.agents.default_model` as data, so retargeting an agent from one model to
 * another is an UPDATE rather than a deploy (ARCHITECTURE.md §6.7 applies the
 * same reasoning to autonomy levels).
 */

export type AiRole = 'user' | 'assistant';

export type AiMessage = {
  role: AiRole;
  content: string;
};

/** Mirrors ai.agents.default_effort. */
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type StructuredRequest = {
  /** Model id as stored in ai.agents.default_model, e.g. 'claude-sonnet-5'. */
  model: string;
  system: string;
  messages: readonly AiMessage[];
  /**
   * JSON Schema the provider must constrain output to. Passed as data so no
   * provider-specific schema helper leaks into callers; the caller re-validates
   * with Zod regardless, because a provider claiming conformance is not proof
   * of it (ARCHITECTURE.md §6.6).
   */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  effort?: AiEffort;
  maxOutputTokens?: number;
};

/**
 * Token and cost accounting for one call. `costMinor` is in minor units to
 * match ai.agent_runs.cost_minor and the money rule in ARCHITECTURE.md §4.1.
 * A provider that cannot report cost reports 0 rather than guessing.
 */
export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
};

export type StructuredResponse = {
  /** Parsed JSON, still unvalidated. The caller applies its Zod schema. */
  json: unknown;
  usage: AiUsage;
  /** Exact model that served the request; may differ from the one requested. */
  model: string;
};

export interface AiProvider {
  /** Stable identifier recorded on the run, e.g. 'anthropic'. */
  readonly id: string;
  /** True when this provider can serve the given model id. */
  supports(model: string): boolean;
  generateStructured(request: StructuredRequest): Promise<Result<StructuredResponse>>;
}
