import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { screenGateSchema, setScreenCategorySchema, type ScreenGateInput, type SetScreenCategoryInput } from './screen-gate-schema';

/**
 * The three screen-review doors (migration 20261006400100): category,
 * QA confirmation, approval. `project.write` for category and approval,
 * `project.sign_off` (owner, ops admin) for the QA confirmation — the
 * database re-checks each and audits.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function setScreenCategory(input: SetScreenCategoryInput): Promise<Result<{ category: string | null }>> {
  const parsed = setScreenCategorySchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid category.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change a screen.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_screen_category', { p_screen_id: parsed.data.screenId, p_category: parsed.data.category });
  if (error) {
    log('setScreenCategory', error.message);
    return err('INTERNAL', 'Could not set the category.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ category: parsed.data.category || null });
    case 'unchanged':
      return err('CONFLICT', 'That is already its category.');
    case 'too_long':
      return err('VALIDATION', 'A category is at most 60 characters.');
    case 'not_found':
      return err('NOT_FOUND', 'Screen not found.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may categorise a screen.');
  }
}

export async function confirmScreenQa(input: ScreenGateInput): Promise<Result<{ confirmed: true }>> {
  const parsed = screenGateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid screen.');
  const context = await requireInternal();
  if (!can(context, 'project.sign_off')) return err('FORBIDDEN', 'Only an owner or ops admin confirms a screen for QA.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('confirm_screen_qa', { p_screen_id: parsed.data.screenId });
  if (error) {
    log('confirmScreenQa', error.message);
    return err('INTERNAL', 'Could not record the QA confirmation.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'confirmed':
      return ok({ confirmed: true });
    case 'already_confirmed':
      return err('CONFLICT', 'QA already confirmed this screen.');
    case 'not_submitted':
      return err('CONFLICT', 'Submit the screen for QA first; there is nothing to confirm until QA has it.');
    case 'superseded':
      return err('CONFLICT', 'A superseded screen cannot be confirmed.');
    case 'not_found':
      return err('NOT_FOUND', 'Screen not found.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner or ops admin confirms QA.');
  }
}

export async function approveScreen(input: ScreenGateInput): Promise<Result<{ approved: true }>> {
  const parsed = screenGateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid screen.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to approve a screen.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('approve_screen', { p_screen_id: parsed.data.screenId });
  if (error) {
    log('approveScreen', error.message);
    return err('INTERNAL', 'Could not approve the screen.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; detail?: string | null } | undefined;
  switch (row?.outcome) {
    case 'approved':
      return ok({ approved: true });
    case 'already_approved':
      return err('CONFLICT', 'This screen is already approved.');
    case 'missing_states':
      return err('CONFLICT', `Not approved: the screen has no ${row.detail ?? 'required'} state drawn. Missing states block design completeness.`);
    case 'qa_not_confirmed':
      return err('CONFLICT', 'Not approved: QA has not confirmed the required sections, buttons, components and navigation.');
    case 'superseded':
      return err('CONFLICT', 'A superseded screen cannot be approved.');
    case 'not_found':
      return err('NOT_FOUND', 'Screen not found.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may approve a screen.');
  }
}
