import { z } from 'zod';

/** Same vocabulary as the sales.opportunities stage CHECK. */
export const OPPORTUNITY_STAGES = [
  'discovery',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

/**
 * Legal stage moves.
 *
 * `won` is terminal — the deal converts into a project from there. `lost`
 * reopens to discovery, because a revived deal starts its cycle again rather
 * than resuming mid-negotiation.
 */
export const OPPORTUNITY_TRANSITIONS: Record<OpportunityStage, readonly OpportunityStage[]> = {
  discovery: ['proposal', 'lost'],
  proposal: ['negotiation', 'won', 'lost'],
  negotiation: ['won', 'lost'],
  won: [],
  lost: ['discovery'],
};

export const createOpportunitySchema = z.object({
  leadId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  /** Deal value in the organization's minor units. */
  valueMinor: z.number().int().nonnegative().max(1_000_000_000_000).default(0),
  expectedCloseOn: z.iso.date().optional(),
});

export const setOpportunityStageSchema = z.object({
  opportunityId: z.uuid(),
  stage: z.enum(OPPORTUNITY_STAGES),
  /** Required when losing a deal. */
  lostReason: z.string().trim().max(500).optional(),
});

export const convertToProjectSchema = z.object({
  opportunityId: z.uuid(),
  projectName: z.string().trim().min(1).max(200),
  /**
   * Only used when the opportunity has no client account yet. Defaults to the
   * opportunity name so a conversion never blocks on naming.
   */
  clientAccountName: z.string().trim().min(1).max(200).optional(),
});

export type CreateOpportunityInput = z.infer<typeof createOpportunitySchema>;
export type SetOpportunityStageInput = z.infer<typeof setOpportunityStageSchema>;
export type ConvertToProjectInput = z.infer<typeof convertToProjectSchema>;
