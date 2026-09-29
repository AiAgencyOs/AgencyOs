import { z } from 'zod';

/**
 * SCR-033 — a person records a theme direction or a colour variant beside
 * the generated ones (migration 20261001130000). The ceiling (2–3 per
 * phase, `theme_option_limit`) and the finalized-baseline rule are the
 * database's; these only shape the input.
 */

const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'A colour is a six-digit hex like #1A2B3C.');

export const recordThemeDirectionSchema = z.object({
  projectId: z.uuid(),
  optionIndex: z.coerce.number().int().min(1).max(5),
  name: z.string().trim().min(1, 'Name the direction.').max(120),
  directionSummary: z.string().trim().min(1, 'Say what the direction is.').max(2000),
});
export type RecordThemeDirectionInput = z.input<typeof recordThemeDirectionSchema>;

export const recordColorVariantSchema = z.object({
  projectId: z.uuid(),
  themeOptionId: z.uuid(),
  optionIndex: z.coerce.number().int().min(1).max(5),
  paletteName: z.string().trim().min(1, 'Name the palette.').max(120),
  primaryHex: hex,
  secondaryHex: hex.optional(),
  accentHex: hex.optional(),
  contrastNotes: z.string().trim().max(2000).optional(),
});
export type RecordColorVariantInput = z.input<typeof recordColorVariantSchema>;
