import { z } from 'zod';

import { LEAD_STATUSES, NURTURE_REASONS } from './schema';

/**
 * Bulk actions over the leads list — SCR-006.
 *
 * Four single-row doors (`setLeadOwner`, `setLeadStatus`, `setLeadTags`,
 * `setLeadFollowUp` in service.ts), each applied once per selected lead. The bulk shape is the
 * union of the single shapes and nothing more: no field exists here that a
 * one-lead form could not also send.
 */
export const BULK_LEAD_LIMIT = 100;

export const bulkLeadActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assign'),
    leadIds: z.array(z.uuid()).min(1).max(BULK_LEAD_LIMIT),
    /** Null clears the assignment. */
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
  // SCR-006 (bucket F-B) — set next follow-up, the single-row `setLeadFollowUp` door per lead.
  z.object({
    kind: z.literal('follow_up'),
    leadIds: z.array(z.uuid()).min(1).max(BULK_LEAD_LIMIT),
    /** ISO instant, or null to clear the reminder. */
    nextFollowUpAt: z.iso.datetime().nullable(),
  }),
]);

export type BulkLeadActionInput = z.infer<typeof bulkLeadActionSchema>;

/** One line per lead: what happened, in the door's own words. */
export type BulkLeadOutcome = { leadId: string; ok: boolean; message: string };
