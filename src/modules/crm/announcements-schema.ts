import { z } from 'zod';

/**
 * Announcements — SCR-017/057 (`crm.announcements`, migration
 * 20260929150000). A record of what was announced to whom; publishing
 * records, it never sends (WhatsApp broadcast is declined, traceability
 * row 59).
 */
export const ANNOUNCEMENT_AUDIENCES = ['internal', 'clients'] as const;
export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'] as const;

export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

export const createAnnouncementSchema = z.object({
  title: z.string().trim().min(1, 'A title is required.').max(160),
  body: z.string().trim().min(1, 'A body is required.').max(5000),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES),
  /** SCR-059: the project this is about — it fixes the client, and is where the timeline records it. */
  projectId: z.uuid().optional(),
  /** SCR-059: one client alone, when no project is named. */
  clientAccountId: z.uuid().optional(),
  /** The template it was written from, when it was. */
  templateId: z.uuid().optional(),
});

export const setAnnouncementStatusSchema = z.object({
  announcementId: z.uuid(),
  status: z.enum(['published', 'archived']),
});

export type CreateAnnouncementInput = z.input<typeof createAnnouncementSchema>;
export type SetAnnouncementStatusInput = z.input<typeof setAnnouncementStatusSchema>;
