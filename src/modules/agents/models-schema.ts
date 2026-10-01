import { z } from 'zod';

import { WORK_CLASSES } from '@/lib/ai/autonomy';
import { PROVIDER_IDS } from '@/lib/ai/model-provider';

/**
 * SCR-064 — Decision 2026-09-30: ADM-84 reversed, the owner manages models in
 * the panel. Mirrors `ai.add_model`, `ai.retire_model`,
 * `ai.set_fallback_chain` and `ai.set_provider_budget` (20261001150000).
 */

/** An id as an adapter accepts it — `claude-sonnet-5`, `openai/gpt-5-mini`. Never translated. */
export const modelId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,119}$/, 'Not a model id an adapter would accept.');

export const MODEL_CAPABILITIES = ['reasoning', 'coding', 'long_context', 'structured_output', 'multimodal'] as const;

export const addModelSchema = z.object({
  modelId,
  provider: z.enum(PROVIDER_IDS),
  capabilities: z.array(z.enum(MODEL_CAPABILITIES)).max(5).default([]),
  contextTokens: z.number().int().positive().max(100_000_000).optional(),
  /** Minor units per million tokens, as the registry stores them. */
  inputCostMinorPerMtok: z.number().int().min(0).max(100_000_000_000).optional(),
  outputCostMinorPerMtok: z.number().int().min(0).max(100_000_000_000).optional(),
});
export type AddModelInput = z.infer<typeof addModelSchema>;

export const retireModelSchema = z.object({
  modelId,
  reason: z.string().trim().min(1, 'Say why the model is being retired.').max(500),
});
export type RetireModelInput = z.infer<typeof retireModelSchema>;

export const setFallbackChainSchema = z.object({
  workClass: z.enum(WORK_CLASSES),
  /** Ordered; empty clears the chain. */
  modelIds: z.array(modelId).max(10, 'At most ten models in a chain.'),
});
export type SetFallbackChainInput = z.infer<typeof setFallbackChainSchema>;

export const setProviderBudgetSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  /** Minor units; 0 clears the cap. */
  monthlyCapMinor: z.number().int().min(0).max(100_000_000_000),
});
export type SetProviderBudgetInput = z.infer<typeof setProviderBudgetSchema>;

export const setModelBudgetSchema = z.object({
  modelId: modelId,
  /** Minor units; 0 clears the cap. */
  monthlyCapMinor: z.number().int().min(0).max(100_000_000_000),
});
export type SetModelBudgetInput = z.infer<typeof setModelBudgetSchema>;
