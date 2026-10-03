import { z } from 'zod';

/** SCR-027 "Template selection" (migration 20261001120000): which saved template a project follows. */
export const setProjectTemplateSchema = z.object({
  projectId: z.uuid(),
  /** Empty clears the selection. */
  templateId: z.uuid().nullable(),
});

export type SetProjectTemplateInput = z.input<typeof setProjectTemplateSchema>;
