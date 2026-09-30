import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  recordColorVariantSchema,
  recordThemeDirectionSchema,
  type RecordColorVariantInput,
  type RecordThemeDirectionInput,
} from './design-direction-schema';

/**
 * SCR-033 — the two doors a person has to record a direction and a variant
 * (migration 20261001130000). `project.write`, the capability every Phase 3
 * decision takes; `core.can_manage_delivery()` again inside. Both wrap the
 * agent's own record functions, so the 2–3 ceiling, the finalized-baseline
 * start condition and the idempotency are decided in exactly one place.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function recordThemeDirection(input: RecordThemeDirectionInput): Promise<Result<{ themeOptionId: string }>> {
  const parsed = recordThemeDirectionSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid direction.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to record a theme direction.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_theme_direction', {
    p_project_id: parsed.data.projectId,
    p_option_index: parsed.data.optionIndex,
    p_name: parsed.data.name,
    p_direction_summary: parsed.data.directionSummary,
  });
  if (error) {
    log('recordThemeDirection', error.message);
    return err('INTERNAL', 'Could not record the direction.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; theme_option_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'recorded':
      return ok({ themeOptionId: row.theme_option_id ?? '' });
    case 'already_recorded':
      return err('CONFLICT', `Option ${parsed.data.optionIndex} is already recorded under this design context.`);
    case 'limit_reached':
      return err('CONFLICT', 'The ceiling for this phase is reached — two or three directions, and not one more.');
    case 'no_phase_three':
      return err('CONFLICT', 'Phase 3 has not started for this project.');
    case 'no_baseline':
      return err('CONFLICT', 'The screen baseline is not finalized yet; a direction drawn against no agreed screens is a picture, not a direction.');
    case 'forbidden':
    case 'no_actor':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may record a direction.');
    default:
      return err('INTERNAL', 'Could not record the direction.');
  }
}

export async function recordColorVariant(input: RecordColorVariantInput): Promise<Result<{ colorOptionId: string }>> {
  const parsed = recordColorVariantSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid variant.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to record a colour variant.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_color_variant', {
    p_theme_option_id: parsed.data.themeOptionId,
    p_option_index: parsed.data.optionIndex,
    p_palette_name: parsed.data.paletteName,
    p_primary_hex: parsed.data.primaryHex,
    p_secondary_hex: parsed.data.secondaryHex,
    p_accent_hex: parsed.data.accentHex,
    p_contrast_notes: parsed.data.contrastNotes,
  });
  if (error) {
    log('recordColorVariant', error.message);
    return err('INTERNAL', 'Could not record the variant.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; color_option_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'recorded':
      return ok({ colorOptionId: row.color_option_id ?? '' });
    case 'already_recorded':
      return err('CONFLICT', `Palette ${parsed.data.optionIndex} is already recorded on this direction.`);
    case 'unknown_option':
      return err('NOT_FOUND', 'Theme direction not found.');
    case 'bad_token':
      return err('VALIDATION', 'A colour is a six-digit hex like #1A2B3C.');
    case 'forbidden':
    case 'no_actor':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may record a variant.');
    default:
      return err('INTERNAL', 'Could not record the variant.');
  }
}
