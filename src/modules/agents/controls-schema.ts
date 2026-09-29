import { z } from 'zod';

/**
 * ADM-82 — Decision: reversed by the owner on 2026-09-29. The owner may
 * enable/disable a registry agent and set its two ceilings from the panel.
 * Mirrors `ai.set_agent_status` / `ai.set_agent_caps` (20260930120000).
 *
 * A disable carries a reason because `agents_disabled_reason_together`
 * (20260814120002) refuses one that does not — an agent disabled for an
 * unrecorded reason is one somebody turns back on.
 */

const agentKey = z.string().regex(/^[a-z][a-z0-9_]{2,48}$/, 'Not an agent key.');

export const setAgentStatusSchema = z
  .object({
    agentKey,
    enabled: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.enabled || (v.reason ?? '').length > 0, {
    message: 'Disabling an agent needs a reason.',
    path: ['reason'],
  });
export type SetAgentStatusInput = z.infer<typeof setAgentStatusSchema>;

export const setAgentCapsSchema = z.object({
  agentKey,
  maxSteps: z.number().int().min(1, 'At least one step.').max(1000, 'At most 1000 steps.'),
  /** Rupees as typed; converted to minor units by the door. */
  maxCostMinor: z.number().int().min(1, 'At least ₹0.01.').max(100_000_000, 'At most ₹10,00,000.'),
});
export type SetAgentCapsInput = z.infer<typeof setAgentCapsSchema>;
