import { z } from 'zod';

/**
 * A project raised by hand — SCR-004's "Create project".
 *
 * Until this door existed the only way a project came to be was winning a
 * deal (`sales/service.ts` → `convertToProject`). Work that arrives without
 * a quotation in the system — a retainer, a referral closed on a call —
 * had no honest row. The shape mirrors what conversion writes, minus the
 * deal it does not have; the dates are the two columns `projects.projects`
 * already carries for them.
 */
export const createProjectManuallySchema = z
  .object({
    clientAccountId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'Currency is a three-letter ISO code.')
      .default('INR'),
    startsOn: z.iso.date().optional(),
    endsOn: z.iso.date().optional(),
    /** Budget in minor units (paise). Optional: a project may be raised before a price is agreed. */
    budgetMinor: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
  })
  .refine((v) => !v.startsOn || !v.endsOn || v.startsOn <= v.endsOn, {
    message: 'The end date cannot be before the start date.',
    path: ['endsOn'],
  });

export type CreateProjectManuallyInput = z.input<typeof createProjectManuallySchema>;
