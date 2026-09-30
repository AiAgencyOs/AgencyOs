import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { addTestPlanItem } from '@/modules/qa/service';

import {
  addScreenSchema,
  linkDesignAssetSchema,
  mergeScreensSchema,
  screenScopeItemSchema,
  setScreenDesignStateSchema,
  setScreenFigmaUrlSchema,
  splitScreenSchema,
  submitScreenForQaSchema,
  unlinkDesignAssetSchema,
  type AddScreenInput,
  type LinkDesignAssetInput,
  type MergeScreensInput,
  type ScreenScopeItemInput,
  type SetScreenDesignStateInput,
  type SetScreenFigmaUrlInput,
  type SplitScreenInput,
  type SubmitScreenForQaInput,
  type UnlinkDesignAssetInput,
} from './screen-schema';

/**
 * SCR-032/034/035/038 — the doors a person has into the screen inventory
 * (migration 20260929200000).
 *
 * `project.write` here, `core.can_manage_delivery()` in the database — the
 * same roles, and the database asks again. Add, merge, split, a design
 * state and a QA submission are RPCs that audit inside their transaction.
 * The Figma link, a scope mapping and an asset link are row writes under
 * the new policies: the row triggers (excluded scope item, tenancy, and —
 * for the mapping only — the finalized baseline) decide, and their refusal
 * is shown verbatim. Only add, merge, split and the mapping follow the
 * baseline; design state, Figma link and QA status stay writable after it.
 */

const CLOSED = 'The screen list is closed for this baseline';

function refused(outcome: string | undefined, detail: string | null | undefined, verb: string): Result<never> {
  switch (outcome) {
    case 'not_found':
      return err('NOT_FOUND', 'Screen or project not found.');
    case 'list_closed':
      return err('CONFLICT', `${CLOSED}: ${detail ?? 'the latest screen baseline is finalized'}. Draft the next baseline version first.`);
    case 'bad_key':
      return err('VALIDATION', 'A key is lowercase letters, digits, "_", "." or "-", 2–63 characters, starting with a letter.');
    case 'duplicate_key':
      return err('CONFLICT', `A screen with the key "${detail ?? ''}" already exists in this project (superseded screens keep their keys).`);
    case 'bad_part':
      return err('VALIDATION', `Part "${detail ?? ''}" needs a valid key and a name.`);
    case 'too_few':
      return err('VALIDATION', 'Pick at least two.');
    case 'already_superseded':
      return err('CONFLICT', 'That screen was already merged or split away.');
    case 'superseded':
      return err('CONFLICT', 'That screen was merged or split away; act on its replacement.');
    case 'unknown_scope_item':
      return err('VALIDATION', 'One of the scope items is not part of this project.');
    case 'excluded_scope_item':
      return err('VALIDATION', `Scope item "${detail ?? ''}" is excluded; designing it is how an exclusion becomes an accidental commitment (Doc 12 §20).`);
    case 'bad_state':
      return err('VALIDATION', 'Not a design state this system recognises.');
    default:
      return err('FORBIDDEN', `You do not have permission to ${verb}.`);
  }
}

type Row = { outcome?: string; detail?: string | null };
const first = <T extends Row>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

async function gate(verb: string): Promise<Result<{ userId: string }>> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', `You do not have permission to ${verb}.`);
  return ok({ userId: context.userId });
}

const blank = (v: string | undefined) => (v && v.length > 0 ? v : undefined);

export async function addScreen(input: AddScreenInput): Promise<Result<{ screenId: string }>> {
  const parsed = addScreenSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid screen.');
  const gated = await gate('add a screen');
  if (!gated.ok) return gated;

  const d = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('add_screen', {
    p_project_id: d.projectId,
    p_screen_key: d.screenKey,
    p_name: d.name,
    p_user_role: d.userRole,
    p_purpose: blank(d.purpose),
    p_required_sections: blank(d.requiredSections),
    p_actions: blank(d.actions),
    p_required_data: blank(d.requiredData),
    p_dependencies: blank(d.dependencies),
    p_entry_point: blank(d.entryPoint),
    p_exit_action: blank(d.exitAction),
    p_has_empty_state: d.hasEmptyState,
    p_has_loading_state: d.hasLoadingState,
    p_has_error_state: d.hasErrorState,
    p_has_success_state: d.hasSuccessState,
    p_scope_item_ids: d.scopeItemIds,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addScreen', detail: error.message }));
    return err('INTERNAL', `Could not add the screen: ${error.message}`);
  }
  const row = first<Row & { screen_id?: string }>(data);
  if (row?.outcome === 'added' && row.screen_id) return ok({ screenId: row.screen_id });
  return refused(row?.outcome, row?.detail, 'add a screen');
}

export async function mergeScreens(input: MergeScreensInput): Promise<Result<{ screenId: string }>> {
  const parsed = mergeScreensSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid merge.');
  const gated = await gate('merge screens');
  if (!gated.ok) return gated;

  const d = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('merge_screens', {
    p_source_ids: d.sourceIds,
    p_screen_key: d.screenKey,
    p_name: d.name,
    p_user_role: blank(d.userRole),
    p_purpose: blank(d.purpose),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'mergeScreens', detail: error.message }));
    return err('INTERNAL', `Could not merge the screens: ${error.message}`);
  }
  const row = first<Row & { screen_id?: string }>(data);
  if (row?.outcome === 'merged' && row.screen_id) return ok({ screenId: row.screen_id });
  return refused(row?.outcome, row?.detail, 'merge screens');
}

export async function splitScreen(input: SplitScreenInput): Promise<Result<{ screenIds: string[] }>> {
  const parsed = splitScreenSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid split.');
  const gated = await gate('split a screen');
  if (!gated.ok) return gated;

  const d = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('split_screen', {
    p_source_id: d.sourceId,
    p_parts: d.parts.map((p) => ({ screenKey: p.screenKey, name: p.name, userRole: blank(p.userRole) ?? null, purpose: blank(p.purpose) ?? null })),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'splitScreen', detail: error.message }));
    return err('INTERNAL', `Could not split the screen: ${error.message}`);
  }
  const row = first<Row & { screen_ids?: string[] }>(data);
  if (row?.outcome === 'split' && row.screen_ids) return ok({ screenIds: row.screen_ids });
  return refused(row?.outcome, row?.detail, 'split a screen');
}

export async function setScreenDesignState(input: SetScreenDesignStateInput): Promise<Result<{ changed: boolean }>> {
  const parsed = setScreenDesignStateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid design state.');
  const gated = await gate('set the design state');
  if (!gated.ok) return gated;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_screen_design_state', {
    p_screen_id: parsed.data.screenId,
    p_design_state: parsed.data.designState,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setScreenDesignState', detail: error.message }));
    return err('INTERNAL', `Could not set the design state: ${error.message}`);
  }
  const row = first<Row>(data);
  if (row?.outcome === 'set') return ok({ changed: true });
  if (row?.outcome === 'unchanged') return ok({ changed: false });
  return refused(row?.outcome, row?.detail, 'set the design state');
}

/**
 * A row write under `screens_update`. Zero rows back means RLS hid the
 * screen; a trigger refusal (finalized baseline, https-only) comes back as
 * the database's own sentence.
 */
export async function setScreenFigmaUrl(input: SetScreenFigmaUrlInput): Promise<Result<{ cleared: boolean }>> {
  const parsed = setScreenFigmaUrlSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid Figma link.');
  const gated = await gate('attach a Figma link');
  if (!gated.ok) return gated;

  const value = parsed.data.figmaUrl.length === 0 ? null : parsed.data.figmaUrl;
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('screens')
    .update({ figma_url: value })
    .eq('id', parsed.data.screenId)
    .eq('project_id', parsed.data.projectId)
    .select('id');
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setScreenFigmaUrl', detail: error.message }));
    return err('CONFLICT', `The database refused the Figma link: ${error.message}`);
  }
  if ((data ?? []).length === 0) return err('FORBIDDEN', 'You do not have permission to attach a Figma link, or the screen is not yours to edit.');
  return ok({ cleared: value === null });
}

export async function mapScreenToScopeItem(input: ScreenScopeItemInput): Promise<Result<{ mapped: boolean }>> {
  const parsed = screenScopeItemSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid mapping.');
  const gated = await gate('map a screen to a requirement');
  if (!gated.ok) return gated;

  const supabase = await createClient();
  const { data: screen, error: screenError } = await supabase
    .schema('projects')
    .from('screens')
    .select('id, organization_id, status')
    .eq('id', parsed.data.screenId)
    .eq('project_id', parsed.data.projectId)
    .maybeSingle();
  if (screenError) {
    console.error(JSON.stringify({ level: 'error', scope: 'mapScreenToScopeItem.screen', detail: screenError.message }));
    return err('INTERNAL', 'Could not read the screen.');
  }
  if (!screen) return err('NOT_FOUND', 'Screen not found.');
  if (screen.status === 'superseded') return refused('superseded', null, 'map a screen to a requirement');

  const { error } = await supabase.schema('projects').from('screen_scope_items').insert({
    organization_id: screen.organization_id,
    screen_id: screen.id,
    scope_item_id: parsed.data.scopeItemId,
  });
  if (error) {
    if (error.code === '23505') return ok({ mapped: false });
    if (error.code === '42501') return err('FORBIDDEN', 'You do not have permission to map a screen to a requirement.');
    console.error(JSON.stringify({ level: 'error', scope: 'mapScreenToScopeItem', detail: error.message }));
    return err('CONFLICT', `The database refused the mapping: ${error.message}`);
  }
  return ok({ mapped: true });
}

export async function unmapScreenScopeItem(input: ScreenScopeItemInput): Promise<Result<{ removed: boolean }>> {
  const parsed = screenScopeItemSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid mapping.');
  const gated = await gate('unmap a screen from a requirement');
  if (!gated.ok) return gated;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('screen_scope_items')
    .delete()
    .eq('screen_id', parsed.data.screenId)
    .eq('scope_item_id', parsed.data.scopeItemId)
    .select('screen_id');
  if (error) {
    if (error.code === '42501') return err('FORBIDDEN', 'You do not have permission to unmap a screen from a requirement.');
    console.error(JSON.stringify({ level: 'error', scope: 'unmapScreenScopeItem', detail: error.message }));
    return err('CONFLICT', `The database refused the change: ${error.message}`);
  }
  return ok({ removed: (data ?? []).length > 0 });
}

/**
 * SCR-035 — hand a screen to QA. The status is the door's; when the project
 * has a DRAFT test plan, a `ui` test-plan item is then added for each scope
 * item the screen covers through `qa.add_test_plan_item` (the qa module's
 * own service, so its `wrong_baseline` / `plan_approved` rules keep
 * deciding). An item already planned is not an error.
 */
export async function submitScreenForQa(
  input: SubmitScreenForQaInput,
): Promise<Result<{ planned: number; skipped: number; planId: string | null; alreadySubmitted: boolean; notes: string[] }>> {
  const parsed = submitScreenForQaSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid submission.');
  const gated = await gate('submit a screen for QA');
  if (!gated.ok) return gated;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('submit_screen_for_qa', { p_screen_id: parsed.data.screenId });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'submitScreenForQa', detail: error.message }));
    return err('INTERNAL', `Could not submit the screen: ${error.message}`);
  }
  const row = first<Row & { scope_item_ids?: string[] | null }>(data);
  if (row?.outcome !== 'submitted' && row?.outcome !== 'already_submitted') {
    return refused(row?.outcome, row?.detail, 'submit a screen for QA');
  }
  const alreadySubmitted = row.outcome === 'already_submitted';
  const scopeItemIds = row.scope_item_ids ?? [];

  const { data: plan, error: planError } = await supabase
    .schema('qa')
    .from('test_plans')
    .select('id, status')
    .eq('project_id', parsed.data.projectId)
    .eq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (planError) {
    console.error(JSON.stringify({ level: 'error', scope: 'submitScreenForQa.plan', detail: planError.message }));
    return ok({ planned: 0, skipped: 0, planId: null, alreadySubmitted, notes: ['The test plan could not be read; no test item was added.'] });
  }
  if (!plan) return ok({ planned: 0, skipped: 0, planId: null, alreadySubmitted, notes: [] });

  const { data: screen } = await supabase.schema('projects').from('screens').select('name, screen_key').eq('id', parsed.data.screenId).maybeSingle();
  const label = screen ? `${screen.name} (${screen.screen_key})` : parsed.data.screenId;

  let planned = 0;
  let skipped = 0;
  const notes: string[] = [];
  for (const scopeItemId of scopeItemIds) {
    const added = await addTestPlanItem({
      planId: plan.id,
      scopeItemId,
      category: 'ui',
      reason: `Screen "${label}" submitted for QA.`,
      criticalPath: false,
    });
    if (added.ok) planned += 1;
    else if (added.error.code === 'CONFLICT' && /already/.test(added.error.message)) skipped += 1;
    else notes.push(added.error.message);
  }
  return ok({ planned, skipped, planId: plan.id, alreadySubmitted, notes: [...new Set(notes)] });
}

// ── SCR-038 ─────────────────────────────────────────────────────────────

export async function linkDesignAsset(input: LinkDesignAssetInput): Promise<Result<{ linkId: string; existed: boolean }>> {
  const parsed = linkDesignAssetSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid link.');
  const gated = await gate('link an asset');
  if (!gated.ok) return gated;

  const supabase = await createClient();
  const { data: asset, error: assetError } = await supabase
    .schema('projects')
    .from('design_assets')
    .select('id, organization_id')
    .eq('id', parsed.data.assetId)
    .eq('project_id', parsed.data.projectId)
    .maybeSingle();
  if (assetError) {
    console.error(JSON.stringify({ level: 'error', scope: 'linkDesignAsset.asset', detail: assetError.message }));
    return err('INTERNAL', 'Could not read the asset.');
  }
  if (!asset) return err('NOT_FOUND', 'Asset not found in this project.');

  const { data, error } = await supabase
    .schema('projects')
    .from('design_asset_links')
    .insert({
      organization_id: asset.organization_id,
      asset_id: asset.id,
      screen_id: parsed.data.screenId ?? null,
      ui_version_id: parsed.data.uiVersionId ?? null,
      created_by: gated.data.userId,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') return ok({ linkId: '', existed: true });
    if (error.code === '42501') return err('FORBIDDEN', 'You do not have permission to link an asset.');
    console.error(JSON.stringify({ level: 'error', scope: 'linkDesignAsset', detail: error.message }));
    return err('CONFLICT', `The database refused the link: ${error.message}`);
  }
  if (!data) return err('FORBIDDEN', 'You do not have permission to link an asset.');
  return ok({ linkId: data.id, existed: false });
}

export async function unlinkDesignAsset(input: UnlinkDesignAssetInput): Promise<Result<{ removed: boolean }>> {
  const parsed = unlinkDesignAssetSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid link.');
  const gated = await gate('unlink an asset');
  if (!gated.ok) return gated;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('design_asset_links').delete().eq('id', parsed.data.linkId).select('id');
  if (error) {
    if (error.code === '42501') return err('FORBIDDEN', 'You do not have permission to unlink an asset.');
    console.error(JSON.stringify({ level: 'error', scope: 'unlinkDesignAsset', detail: error.message }));
    return err('CONFLICT', `The database refused the change: ${error.message}`);
  }
  return ok({ removed: (data ?? []).length > 0 });
}
