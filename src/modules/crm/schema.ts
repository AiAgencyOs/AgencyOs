import { z } from 'zod';

/**
 * Input validation for the crm module (ARCHITECTURE.md §3.2 — the only place
 * it happens).
 */

export const startConversationSchema = z.object({
  leadId: z.uuid(),
  channel: z.enum(['manual', 'whatsapp', 'web_form', 'email']).default('manual'),
});

export const appendMessageSchema = z.object({
  conversationId: z.uuid(),
  /** 'client' is the customer, 'user' a staff member. Same vocabulary as
   *  crm.lead_activities.actor_type; 'agent' is written by the runner, not here. */
  authorType: z.enum(['user', 'client']),
  body: z.string().trim().min(1, 'Message cannot be empty').max(10_000),
});

export const requestExtractionSchema = z.object({
  conversationId: z.uuid(),
});

/**
 * The structured shape a requirement extraction must produce.
 *
 * ── Why these four fields and no others ───────────────────────────────────
 * Requirements exist to feed the Proposal Drafter, so the payload carries what
 * sales.proposals and sales.proposal_items actually consume and nothing more:
 *
 *   summary        → sales.proposals.body
 *   scopeItems[]   → sales.proposal_items.description (one row each)
 *   constraints[]  → qualifiers that shape scope (deadlines, stack, compliance)
 *   openQuestions[]→ what the interview still needs; the whole point of an
 *                    agent whose registry description is "Interviews a lead to
 *                    gather structured project requirements"
 *
 * Budget and pricing are deliberately absent: Budget Qualification is a
 * separate, explicitly out-of-scope phase, and putting a money field here now
 * would prejudge its design.
 */
export const requirementPayloadSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  scopeItems: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        detail: z.string().trim().max(2_000).optional(),
      }),
    )
    .max(50),
  constraints: z.array(z.string().trim().min(1).max(500)).max(50),
  openQuestions: z.array(z.string().trim().min(1).max(500)).max(50),
});

export type StartConversationInput = z.infer<typeof startConversationSchema>;
export type AppendMessageInput = z.infer<typeof appendMessageSchema>;
export type RequestExtractionInput = z.infer<typeof requestExtractionSchema>;
export type RequirementPayload = z.infer<typeof requirementPayloadSchema>;

/**
 * JSON Schema handed to the provider for constrained decoding. Derived from
 * the Zod schema so the two cannot drift.
 */
export function requirementJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(requirementPayloadSchema) as Record<string, unknown>;
}
