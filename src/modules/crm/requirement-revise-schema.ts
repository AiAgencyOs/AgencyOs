import { z } from 'zod';

import { requirementPayloadSchema } from './schema';

/**
 * SCR-009 — "Edit as new version". The payload is the whole vocabulary the
 * requirement panel renders (`requirementPayloadSchema`): the summary, the
 * scope items and the six lists. The source version must be one that stands
 * (proposed or accepted); the door refuses anything else by outcome.
 */
export const reviseRequirementVersionSchema = z.object({
  versionId: z.uuid(),
  payload: requirementPayloadSchema,
});

export type ReviseRequirementVersionInput = z.infer<typeof reviseRequirementVersionSchema>;

/** One entry per non-blank line. Pure, so the form and the action agree on it. */
export function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Scope items are typed one per line as `Title — detail` (or `Title | detail`,
 * or `Title: detail`); a line with no separator is a title alone. The same
 * shape the panel prints, so what a person sees is what they edit.
 */
export function scopeItemsOf(text: string): { title: string; detail?: string }[] {
  return linesOf(text).map((line) => {
    const m = /^(.*?)\s*(?:—|\||:)\s+(.+)$/.exec(line);
    if (!m) return { title: line };
    const title = m[1]!.trim();
    const detail = m[2]!.trim();
    return title.length > 0 ? { title, detail } : { title: line };
  });
}

export function scopeItemsToLines(items: ReadonlyArray<{ title: string; detail?: string | null }>): string {
  return items.map((i) => (i.detail ? `${i.title} — ${i.detail}` : i.title)).join('\n');
}
