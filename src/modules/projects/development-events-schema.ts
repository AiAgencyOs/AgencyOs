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

/** SCR-040 — a planner asks the PM to request an outstanding client dependency from the client (migration 20261008130000). */
export const requestClientDependencySchema = z.object({
  projectId: z.uuid(),
  dependencyId: z.uuid(),
  note: z.string().trim().max(4000).optional(),
});
export type RequestClientDependencyInput = z.infer<typeof requestClientDependencySchema>;
