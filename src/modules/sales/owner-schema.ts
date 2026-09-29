import { z } from 'zod';

/** Who owns a deal — SCR-012's sales owner select over `opportunities.owner_id`. */
export const setOpportunityOwnerSchema = z.object({
  opportunityId: z.uuid(),
  ownerId: z.uuid(),
});

export type SetOpportunityOwnerInput = z.infer<typeof setOpportunityOwnerSchema>;
