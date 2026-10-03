import { z } from 'zod';

/**
 * Time logs — decision 4 of 2026-09-29 (migration 20260930110000). Manual
 * hours per task with a date and a note. Quarter-hour granularity is not
 * enforced: `hours` is whatever the person typed, to two decimals, above
 * zero and at most a day.
 */

const hours = z.coerce
  .number()
  .refine((n) => Number.isFinite(n) && n > 0, 'Hours must be more than zero.')
  .refine((n) => n <= 24, 'Hours cannot exceed 24 in one entry.')
  .transform((n) => Math.round(n * 100) / 100);

export const addTimeLogSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  hours,
  loggedOn: z.iso.date('Pick the date the time was spent.'),
  note: z.string().trim().max(1000).default(''),
});

export const updateTimeLogSchema = z.object({
  timeLogId: z.uuid(),
  hours,
  loggedOn: z.iso.date('Pick the date the time was spent.'),
  note: z.string().trim().max(1000).default(''),
});

export const deleteTimeLogSchema = z.object({ timeLogId: z.uuid() });

export type AddTimeLogInput = z.input<typeof addTimeLogSchema>;
export type UpdateTimeLogInput = z.input<typeof updateTimeLogSchema>;
export type DeleteTimeLogInput = z.input<typeof deleteTimeLogSchema>;
