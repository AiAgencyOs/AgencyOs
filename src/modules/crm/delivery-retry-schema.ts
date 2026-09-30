import { z } from 'zod';

/**
 * SCR-057 / SCR-060 — retry one failed outbound message, by its id, with the
 * reason a person is sending it again ("requeue with reason"). The reason is
 * kept beside the retry (`crm.requeue_failed_delivery`) so the next person
 * reading the row knows why it went a second time.
 */
export const retryFailedDeliverySchema = z.object({
  messageId: z.uuid(),
  reason: z.string().trim().min(5, 'Say why you are sending it again (at least a few words).').max(600),
});

export type RetryFailedDeliveryInput = z.infer<typeof retryFailedDeliverySchema>;
