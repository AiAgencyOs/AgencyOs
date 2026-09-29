import { z } from 'zod';

/** SCR-057 — retry one failed outbound message, by its id. */
export const retryFailedDeliverySchema = z.object({ messageId: z.uuid() });

export type RetryFailedDeliveryInput = z.infer<typeof retryFailedDeliverySchema>;
