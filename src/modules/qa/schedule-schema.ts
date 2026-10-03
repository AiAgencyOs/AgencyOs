import { z } from 'zod';

import { parseCron } from './cron';
import { TEST_RUN_SUITES } from './schema';

/** SCR-048 — a suite on a cron expression, opened as a run by the tick. */
export const setSuiteScheduleSchema = z.object({
  projectId: z.uuid(),
  deliverableId: z.uuid('Pick the build the scheduled run is opened against.'),
  suite: z.enum(TEST_RUN_SUITES),
  cron: z
    .string()
    .trim()
    .min(9, 'Five fields: minute hour day month weekday.')
    .max(120)
    .refine((v) => parseCron(v) !== null, 'That is not a cron expression this scheduler reads (five numeric fields).'),
  active: z.boolean().default(true),
  remove: z.boolean().default(false),
});
export type SetSuiteScheduleInput = z.input<typeof setSuiteScheduleSchema>;
