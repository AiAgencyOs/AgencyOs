import { z } from 'zod';

import { LEAD_STATUSES, NURTURE_REASONS } from './schema';

/**
 * Bulk actions over the leads list — SCR-006.
 *
 * Three single-row doors, each applied once per selected lead. The bulk
 * shape is deliberately the union of the single shapes and nothing more:
 * no field exists here that a one-lead form could not also send.
 */
export const BULK_LEAD_LIMIT = 100;

export const setLeadOwnerSchema = z.object({
  leadId: z.uuid(),
  /** Null clears the assignment. */
  ownerId: z.uuid().nullable(),
});

export const setLeadTagsSchema = z.object({
  leadId: z.uuid(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30),
});

export const bulkLeadActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assign'),
    leadIds: z.array(z.uuid()).min(1).max(BULK_LEAD_LIMIT),
    ownerId: z.uuid().nullable(),
  }),
  z.object({
    kind: z.literal('status'),
    leadIds: z.array(z.uuid()).min(1).max(BULK_LEAD_LIMIT),
    status: z.enum(LEAD_STATUSES),
    reason: z.string().trim().max(500).optional(),
    nurtureReason: z.enum(NURTURE_REASONS).optional(),
    nurtureUntil: z.string().trim().optional(),
  }),
  z.object({
    kind: z.literal('tag'),
    leadIds: z.array(z.uuid()).min(1).max(BULK_LEAD_LIMIT),
    tag: z.string().trim().min(1).max(40),
  }),
]);

export type SetLeadOwnerInput = z.infer<typeof setLeadOwnerSchema>;
export type SetLeadTagsInput = z.infer<typeof setLeadTagsSchema>;
export type BulkLeadActionInput = z.infer<typeof bulkLeadActionSchema>;

/** One line per lead: what happened, in the door's own words. */
export type BulkLeadOutcome = { leadId: string; ok: boolean; message: string };
