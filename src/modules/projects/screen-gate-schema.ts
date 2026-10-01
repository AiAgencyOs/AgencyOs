import { z } from 'zod';

/** SCR-034/035 — the screen's category, QA confirmation and approval (migration 20261006400100). */
export const setScreenCategorySchema = z.object({
  projectId: z.uuid(),
  screenId: z.uuid(),
  category: z.string().trim().max(60, 'A category is at most 60 characters.'),
});
export type SetScreenCategoryInput = z.input<typeof setScreenCategorySchema>;

export const screenGateSchema = z.object({ projectId: z.uuid(), screenId: z.uuid() });
export type ScreenGateInput = z.input<typeof screenGateSchema>;
