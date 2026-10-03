import { z } from 'zod';

/**
 * Handing a lead to a person — SCR-057's "assign handoff".
 *
 * `crm.leads.assigned_to` has existed since the schema was written and the
 * meetings list already filters on it; nothing ever wrote it from the
 * product. An empty assignee clears the assignment rather than being
 * refused, so "nobody owns this any more" is a thing a person can say.
 */
export const assignLeadSchema = z.object({
  leadId: z.uuid(),
  assigneeId: z.uuid().nullable(),
});

export type AssignLeadInput = z.infer<typeof assignLeadSchema>;
