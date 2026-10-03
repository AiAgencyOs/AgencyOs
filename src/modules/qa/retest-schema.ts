import { z } from 'zod';

/** SCR-044/046/047 — ask a member to verify a fixed defect (`qa.assign_retest`). */
export const assignRetestSchema = z.object({
  projectId: z.uuid(),
  defectId: z.uuid(),
  retesterId: z.uuid('Pick who verifies the fix.'),
  note: z.string().trim().max(600).optional(),
});
export type AssignRetestInput = z.infer<typeof assignRetestSchema>;
