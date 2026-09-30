import { z } from 'zod';

/**
 * A task's start date, subtasks and labels, and a project's notes — the doors
 * of migration 20261004100000. The rules the database enforces (start ≤ due,
 * one level of subtask, eight labels of 24 characters) are repeated here only
 * so a person is told in words before the round trip.
 */

export const LABEL_MAX = 24;
export const LABELS_MAX = 8;

/** Splits "Feature, Backend" into ["Feature", "Backend"]; the database trims and de-duplicates again. */
export function parseLabels(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export const addSubtaskSchema = z.object({
  projectId: z.uuid(),
  parentTaskId: z.uuid(),
  title: z.string().trim().min(1, 'A subtask needs a title').max(200),
  dueOn: z.iso.date().nullable().default(null),
  assigneeId: z.uuid().nullable().default(null),
});
export type AddSubtaskInput = z.input<typeof addSubtaskSchema>;

export const setTaskLabelsSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  labels: z
    .array(z.string().trim().min(1).max(LABEL_MAX, `A label is at most ${LABEL_MAX} characters.`))
    .max(LABELS_MAX, `A task carries at most ${LABELS_MAX} labels.`),
});
export type SetTaskLabelsInput = z.input<typeof setTaskLabelsSchema>;

export const addProjectNoteSchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1, 'Give the note a title.').max(160),
  body: z.string().trim().max(4000).nullable().default(null),
});
export type AddProjectNoteInput = z.input<typeof addProjectNoteSchema>;

export const removeProjectNoteSchema = z.object({ projectId: z.uuid(), noteId: z.uuid() });
export type RemoveProjectNoteInput = z.input<typeof removeProjectNoteSchema>;

/** My tasks' per-column "Add task": a task for the caller, born in the column's status. Blocked is not offered (it needs a reason). */
export const MY_TASK_ADD_STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;
export const addMyTaskSchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1, 'A task needs a title').max(200),
  dueOn: z.iso.date().nullable().default(null),
  status: z.enum(MY_TASK_ADD_STATUSES).default('todo'),
});
export type AddMyTaskInput = z.input<typeof addMyTaskSchema>;
