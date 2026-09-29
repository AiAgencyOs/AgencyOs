import { z } from 'zod';

/**
 * SCR-029 (bucket G-3) — "Link to quotation/design/development task". A
 * person declares that a requirement version is what a quotation prices, a
 * design realises or a task builds. Mirrors `crm.link_requirement`.
 */
export const REQUIREMENT_LINK_TARGETS = ['quotation', 'design', 'task'] as const;
export type RequirementLinkTarget = (typeof REQUIREMENT_LINK_TARGETS)[number];

export const REQUIREMENT_LINK_TARGET_LABEL: Record<RequirementLinkTarget, string> = {
  quotation: 'Quotation',
  design: 'Design',
  task: 'Development task',
};

export const linkRequirementSchema = z.object({
  versionId: z.uuid(),
  targetType: z.enum(REQUIREMENT_LINK_TARGETS),
  targetId: z.uuid(),
  note: z.string().trim().max(500).optional(),
});

export type LinkRequirementInput = z.infer<typeof linkRequirementSchema>;
