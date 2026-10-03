import { z } from 'zod';

/** Project links — SCR-019 (migration 20261001120000). A labelled URL with a kind; a reference, never a copy. */
export const PROJECT_LINK_KINDS = ['repository', 'design', 'document', 'environment', 'tracker', 'other'] as const;
export type ProjectLinkKind = (typeof PROJECT_LINK_KINDS)[number];

const url = z
  .string()
  .trim()
  .min(1, 'A link is required.')
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v), 'The link must start with http:// or https://.');

export const addProjectLinkSchema = z.object({
  projectId: z.uuid(),
  label: z.string().trim().min(1, 'Give the link a label.').max(120),
  url,
  kind: z.enum(PROJECT_LINK_KINDS).default('other'),
});

export const removeProjectLinkSchema = z.object({ linkId: z.uuid() });

export type AddProjectLinkInput = z.input<typeof addProjectLinkSchema>;
export type RemoveProjectLinkInput = z.input<typeof removeProjectLinkSchema>;
