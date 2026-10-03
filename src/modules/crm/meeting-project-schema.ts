import { z } from 'zod';

/** SCR-010 — link a meeting to a project (`crm.meetings.project_id`, 20261001110000). Null unlinks. */
export const linkMeetingProjectSchema = z.object({
  meetingId: z.uuid(),
  projectId: z.uuid().nullable(),
});
export type LinkMeetingProjectInput = z.infer<typeof linkMeetingProjectSchema>;
