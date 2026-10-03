import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { responsiveCoverage, setScreenStatesSchema, type SetScreenStatesInput } from './screen-states-schema';

/**
 * SCR-035 — the edit-states door (migration 20261001130000). `project.write`
 * here, `core.can_manage_delivery()` and `screens_update` in the database.
 * Not bound to the screen baseline: which states a screen has is drawing
 * progress, not what the list covers.
 */
export async function setScreenStates(input: SetScreenStatesInput): Promise<Result<{ set: true }>> {
  const parsed = setScreenStatesSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid screen states.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to edit a screen.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_screen_states', {
    p_screen_id: parsed.data.screenId,
    p_has_empty_state: parsed.data.hasEmptyState,
    p_has_loading_state: parsed.data.hasLoadingState,
    p_has_error_state: parsed.data.hasErrorState,
    p_has_success_state: parsed.data.hasSuccessState,
    p_user_role: parsed.data.userRole || undefined,
    p_device_targets: parsed.data.deviceTargets,
    p_components: parsed.data.components,
    p_responsive_coverage: responsiveCoverage(parsed.data.deviceTargets, parsed.data.responsiveCovered),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setScreenStates', detail: error.message }));
    return err('INTERNAL', 'Could not save the screen.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ set: true });
    case 'not_found':
      return err('NOT_FOUND', 'Screen not found.');
    case 'superseded':
      return err('CONFLICT', 'This screen was merged or split away and takes no further change.');
    case 'bad_coverage':
      return err('VALIDATION', 'Responsive coverage must be an object.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may edit a screen.');
    default:
      return err('INTERNAL', 'Could not save the screen.');
  }
}
