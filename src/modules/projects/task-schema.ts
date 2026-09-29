import { z } from 'zod';

import { TASK_STATUSES } from './schema';

/** Matches the CHECK on projects.tasks.priority. */
export const TASK_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * Editing a task's own fields — SCR-021's drawer and reassign. Every field is
 * optional so one form can change one thing; `assigneeId: null` and
 * `dueOn: null` are explicit clears rather than "leave alone", which is why
 * they are `nullable().optional()` and not merely optional.
 *
 * Status is deliberately NOT here: `setTaskStatus` owns it, with the
 * `completed_at` rule that goes with `done`, and a second writer of the same
 * column would be a second definition of when a task is finished.
 */
export const updateTaskSchema = z
  .object({
    taskId: z.uuid(),
    title: z.string().trim().min(1, 'A task needs a title').max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    assigneeId: z.uuid().nullable().optional(),
    dueOn: z.iso.date().nullable().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.priority !== undefined ||
      v.assigneeId !== undefined ||
      v.dueOn !== undefined,
    { message: 'Nothing to change.' },
  );

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export { TASK_STATUSES };
