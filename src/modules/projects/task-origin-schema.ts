import { z } from 'zod';

/**
 * Agent-generated work (SCR-020): "not complete until required verification
 * passes". A task is marked as produced by an agent; it cannot move to done
 * until a person verifies it, saying what was checked. Migration 20261006200000.
 */
export const markTaskAgentSchema = z.object({ projectId: z.uuid(), taskId: z.uuid(), agent: z.boolean() });
export type MarkTaskAgentInput = z.input<typeof markTaskAgentSchema>;

export const verifyAgentTaskSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  note: z.string().trim().min(1, 'Say what you checked.').max(1000),
});
export type VerifyAgentTaskInput = z.input<typeof verifyAgentTaskSchema>;
