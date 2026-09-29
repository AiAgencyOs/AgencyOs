import { z } from 'zod';

import { WORK_CLASSES } from '@/lib/ai/autonomy';

/**
 * SCR-063 — which ADM-61 work classes an agent may be handed. Mirrors
 * `ai.set_agent_work_classes` (20261001150000). An empty list means every
 * class, as before the column existed; a non-empty list is exhaustive and
 * the runner refuses a workflow outside it.
 */
export const setAgentWorkClassesSchema = z.object({
  agentKey: z.string().regex(/^[a-z][a-z0-9_]{2,48}$/, 'Not an agent key.'),
  workClasses: z.array(z.enum(WORK_CLASSES)).max(WORK_CLASSES.length),
});
export type SetAgentWorkClassesInput = z.infer<typeof setAgentWorkClassesSchema>;
