import { z } from 'zod';

/**
 * Project templates. Decision: reversed by the owner on 2026-09-29
 * (migration 20260930110000). A template is a named snapshot of one
 * project's structure; a project is raised from one through the by-hand
 * door plus the snapshot written back. `TemplateItems` is the shape of the
 * `template_items` jsonb column — validated on the way in AND on the way
 * out, since a jsonb column promises nothing about its contents.
 */

export const templateItemsSchema = z.object({
  modules: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().nullable().default(null),
        features: z.array(z.object({ name: z.string().trim().min(1).max(200), description: z.string().nullable().default(null) })).default([]),
      }),
    )
    .default([]),
  /** Milestones as percentages of whatever the new project's budget is. */
  milestones: z
    .array(z.object({ name: z.string().trim().min(1).max(200), percent: z.number().min(0).max(100), description: z.string().nullable().default(null) }))
    .default([]),
  scopeItems: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        detail: z.string().nullable().default(null),
        inclusion: z.string().default('included'),
        acceptanceCriteria: z.string().nullable().default(null),
      }),
    )
    .default([]),
  onboarding: z.array(z.object({ key: z.string().min(1).max(100), label: z.string().min(1).max(300), position: z.number().int().nonnegative() })).default([]),
  /** Task titles, each with the module it sits under (by name) so it lands in the right place. */
  tasks: z.array(z.object({ title: z.string().trim().min(1).max(200), moduleName: z.string().nullable().default(null), description: z.string().nullable().default(null) })).default([]),
});

export type TemplateItems = z.infer<typeof templateItemsSchema>;

export const createProjectTemplateFromProjectSchema = z.object({
  projectId: z.uuid(),
  name: z.string().trim().min(1, 'Give the template a name.').max(200),
  description: z.string().trim().max(1000).default(''),
});

export const createProjectFromTemplateSchema = z.object({
  templateId: z.uuid(),
  clientAccountId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Currency is a three-letter ISO code.')
    .default('INR'),
  startsOn: z.iso.date().optional(),
  endsOn: z.iso.date().optional(),
  budgetMinor: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
});

export const deleteProjectTemplateSchema = z.object({ templateId: z.uuid() });

export type CreateProjectTemplateFromProjectInput = z.input<typeof createProjectTemplateFromProjectSchema>;
export type CreateProjectFromTemplateInput = z.input<typeof createProjectFromTemplateSchema>;
export type DeleteProjectTemplateInput = z.input<typeof deleteProjectTemplateSchema>;

/** What the milestone share of a template adds up to; a plan is only written when this is exactly 100. */
export function milestonePercentTotal(items: Pick<TemplateItems, 'milestones'>): number {
  return Math.round(items.milestones.reduce((sum, m) => sum + m.percent, 0) * 100) / 100;
}

export const cloneProjectTemplateSchema = z.object({
  templateId: z.uuid(),
  name: z.string().trim().min(1, 'Give the copy a name.').max(200),
});
export type CloneProjectTemplateInput = z.input<typeof cloneProjectTemplateSchema>;

/** "Copy of X", trimmed to the 200-character limit — the name a clone starts with. */
export function cloneName(name: string): string {
  const prefixed = `Copy of ${name.trim()}`;
  return prefixed.length > 200 ? prefixed.slice(0, 200).trimEnd() : prefixed;
}
