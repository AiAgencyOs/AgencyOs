import { z } from 'zod';

/**
 * Project updates — SCR-019 "Send project update" (migration 20261001120000).
 * `client` goes through the project's WhatsApp group thread and the one
 * outbound chokepoint (`crm.send_outbound_message` via `sendClientMessage`);
 * `internal` is recorded on the project for the team.
 */
export const PROJECT_UPDATE_AUDIENCES = ['client', 'internal'] as const;
export type ProjectUpdateAudience = (typeof PROJECT_UPDATE_AUDIENCES)[number];

export const sendProjectUpdateSchema = z.object({
  projectId: z.uuid(),
  body: z.string().trim().min(1, 'Write the update first.').max(4000),
  sentTo: z.enum(PROJECT_UPDATE_AUDIENCES),
});

export type SendProjectUpdateInput = z.input<typeof sendProjectUpdateSchema>;
