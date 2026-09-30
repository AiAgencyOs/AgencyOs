import { z } from 'zod';

/**
 * A project's type, technology and tags — owner decision 4, migration
 * 20261005100200. The TYPE is from a fixed list; technology and tags are
 * free-text chips: trimmed, lower-cased, unique, 1–30 characters each, at most
 * 12 technology chips and 10 tags. The database normalises and bounds them
 * again; the rules are repeated here so a person is told in words first.
 */
export const PROJECT_TYPES = ['Website', 'Web app', 'Mobile app', 'SaaS', 'E-commerce', 'Branding', 'Other'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const CHIP_MAX_LENGTH = 30;
export const TECHNOLOGY_MAX = 12;
export const TAGS_MAX = 10;

export function isProjectType(value: unknown): value is ProjectType {
  return typeof value === 'string' && (PROJECT_TYPES as readonly string[]).includes(value);
}

/** A stored type, or null when it is unset or not on the list. */
export function projectTypeOf(value: unknown): ProjectType | null {
  return isProjectType(value) ? value : null;
}

/** "React, Node.js\nreact" → ["react", "node.js"]: split on commas and newlines, trim, lower-case, drop blanks and repeats, keep first-seen order. */
export function normaliseChips(input: string | readonly string[]): string[] {
  const parts = typeof input === 'string' ? input.split(/[,\n]/) : input;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const chip = part.trim().toLowerCase();
    if (chip === '' || seen.has(chip)) continue;
    seen.add(chip);
    out.push(chip);
  }
  return out;
}

const chips = (max: number, noun: string) =>
  z
    .array(z.string().min(1).max(CHIP_MAX_LENGTH, `A ${noun} is at most ${CHIP_MAX_LENGTH} characters.`))
    .max(max, `A project carries at most ${max} ${noun}s.`);

export const setProjectClassificationSchema = z.object({
  projectId: z.uuid(),
  /** null = not set. */
  type: z.enum(PROJECT_TYPES).nullable(),
  technology: chips(TECHNOLOGY_MAX, 'technology'),
  tags: chips(TAGS_MAX, 'tag'),
});
export type SetProjectClassificationInput = z.input<typeof setProjectClassificationSchema>;
