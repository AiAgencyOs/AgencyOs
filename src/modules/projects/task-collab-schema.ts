import { z } from 'zod';

/**
 * Task collaboration — SCR-020 / SCR-021 / SCR-041. Comments, checklist
 * items and attachments on `projects.tasks` (migration 20260929140000).
 * The blocked reason itself rides on `setTaskStatusSchema` in schema.ts,
 * because it is part of the status move, not a separate write.
 */

const url = z
  .string()
  .trim()
  .min(1, 'A link is required.')
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v), 'The link must start with http:// or https://.');

export const addTaskCommentSchema = z.object({
  taskId: z.uuid(),
  body: z.string().trim().min(1, 'Write something first.').max(4000),
});

export const addChecklistItemSchema = z.object({
  taskId: z.uuid(),
  label: z.string().trim().min(1, 'A checklist item needs a label.').max(300),
});

export const setChecklistItemDoneSchema = z.object({
  itemId: z.uuid(),
  done: z.boolean(),
});

export const removeChecklistItemSchema = z.object({ itemId: z.uuid() });

export const addTaskAttachmentSchema = z.object({
  taskId: z.uuid(),
  title: z.string().trim().min(1, 'Give the link a title.').max(200),
  url,
});

export const removeTaskAttachmentSchema = z.object({ attachmentId: z.uuid() });

export type AddTaskCommentInput = z.infer<typeof addTaskCommentSchema>;
export type AddChecklistItemInput = z.infer<typeof addChecklistItemSchema>;
export type SetChecklistItemDoneInput = z.infer<typeof setChecklistItemDoneSchema>;
export type RemoveChecklistItemInput = z.infer<typeof removeChecklistItemSchema>;
export type AddTaskAttachmentInput = z.infer<typeof addTaskAttachmentSchema>;
export type RemoveTaskAttachmentInput = z.infer<typeof removeTaskAttachmentSchema>;
