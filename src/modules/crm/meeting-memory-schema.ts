import { z } from 'zod';

/** SCR-017 — attach a meeting's summary to one project's memory. */
export const attachMeetingSummarySchema = z.object({
  meetingId: z.uuid(),
  projectId: z.uuid(),
});

export type AttachMeetingSummaryInput = z.infer<typeof attachMeetingSummarySchema>;
