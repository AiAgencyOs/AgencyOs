import { z } from 'zod';

/** Q-BAND — the owner's budget bands as the form sends them: one band per line. */
export const setBudgetBandsSchema = z.object({
  bandText: z.string().max(2000),
});
export type SetBudgetBandsInput = z.input<typeof setBudgetBandsSchema>;
