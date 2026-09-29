import { z } from 'zod';

/** SCR-039 — a blocker escalated to the PM and a QA handoff started, recorded (migration 20261001130000). */

export const escalateBlockerSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  reason: z.string().trim().min(1, 'Say why this needs the PM.').max(4000),
});
export type EscalateBlockerInput = z.infer<typeof escalateBlockerSchema>;

export const acknowledgeEscalationSchema = z.object({
  projectId: z.uuid(),
  eventId: z.uuid(),
});
export type AcknowledgeEscalationInput = z.infer<typeof acknowledgeEscalationSchema>;

export const startQaHandoffSchema = z.object({ projectId: z.uuid() });
export type StartQaHandoffInput = z.infer<typeof startQaHandoffSchema>;
