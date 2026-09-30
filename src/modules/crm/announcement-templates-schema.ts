import { z } from 'zod';

import { ANNOUNCEMENT_AUDIENCES } from './announcements-schema';

/**
 * Reusable announcement formats — SCR-059 and §7 "Announcement templates"
 * (`crm.announcement_templates`, 20261006500200). A template is a title and a
 * body with four placeholders; the milestone template, while active, drafts an
 * announcement whenever a client-visible milestone is met. The owner writes
 * them; publishing what they draft stays the owner's act.
 */
export const ANNOUNCEMENT_TEMPLATE_KINDS = ['general', 'milestone'] as const;
export type AnnouncementTemplateKind = (typeof ANNOUNCEMENT_TEMPLATE_KINDS)[number];

export const TEMPLATE_PLACEHOLDERS = ['{{project}}', '{{client}}', '{{milestone}}', '{{due}}'] as const;

export const saveAnnouncementTemplateSchema = z.object({
  templateId: z.uuid().optional(),
  name: z.string().trim().min(1, 'Name the template.').max(120),
  kind: z.enum(ANNOUNCEMENT_TEMPLATE_KINDS),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES),
  titleTemplate: z.string().trim().min(1, 'The template needs a title.').max(160),
  bodyTemplate: z.string().trim().min(1, 'The template needs a body.').max(5000),
  active: z.boolean().default(true),
});
export type SaveAnnouncementTemplateInput = z.input<typeof saveAnnouncementTemplateSchema>;

/** What the placeholders become. Mirrors `crm.render_announcement_text`, so a preview says what a draft will. */
export type TemplateValues = { project?: string | null; client?: string | null; milestone?: string | null; due?: string | null };

export function renderAnnouncementText(text: string, values: TemplateValues): string {
  return text
    .replaceAll('{{project}}', values.project ?? '')
    .replaceAll('{{client}}', values.client ?? '')
    .replaceAll('{{milestone}}', values.milestone ?? '')
    .replaceAll('{{due}}', values.due ?? '');
}
