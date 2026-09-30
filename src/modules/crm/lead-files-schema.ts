import { z } from 'zod';

/**
 * Owner decision 11 — links kept on a lead. A title and an http(s) address;
 * the same rules the database applies (`crm.add_lead_file`).
 */
export const addLeadFileSchema = z.object({
  leadId: z.uuid(),
  title: z.string().trim().min(1, 'A file needs a title').max(200),
  url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https?:\/\/\S+$/i, 'Paste a full link starting with https://'),
});
export type AddLeadFileInput = z.input<typeof addLeadFileSchema>;

export const removeLeadFileSchema = z.object({ fileId: z.uuid(), leadId: z.uuid() });
export type RemoveLeadFileInput = z.input<typeof removeLeadFileSchema>;

/** The project file category a carried lead link lands in. */
export const CARRIED_LEAD_FILE_CATEGORY = 'documents' as const;
