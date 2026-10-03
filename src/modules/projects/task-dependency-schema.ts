import { z } from 'zod';

/** R2-1 — a task's own dependencies: the doors of migration 20261009500000. */
export const taskDependencySchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  dependsOnTaskId: z.uuid(),
});
export type TaskDependencyInput = z.input<typeof taskDependencySchema>;

/** The sentence for each outcome the add door refuses with. */
export const ADD_DEPENDENCY_MESSAGES: Record<string, string> = {
  itself: 'A task cannot depend on itself.',
  other_project: 'A task can depend only on a task of its own project.',
  already: 'The task already depends on that one.',
  cycle: 'That would make the two tasks wait for each other.',
  not_found: 'Task not found.',
};
