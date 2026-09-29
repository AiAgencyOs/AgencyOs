import { z } from 'zod';

/** SCR-059 — a draft announcement published by the tick at a moment (`crm.schedule_announcement`). Blank clears it. */
export const scheduleAnnouncementSchema = z.object({
  announcementId: z.uuid(),
  /** ISO timestamp, or empty to unschedule. */
  scheduledFor: z.string().trim().max(40),
});
export type ScheduleAnnouncementInput = z.infer<typeof scheduleAnnouncementSchema>;
