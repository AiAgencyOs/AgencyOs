import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The screen inventory and the design handoff package, as exports —
 * SCR-034 and SCR-038.
 *
 * `projects.screens` is written by the Phase 3 designer agent through the
 * service role and read by the coverage trigger; `readDesignTrail` shows
 * the baseline's count. This reads the rows themselves, every column a
 * person or a spreadsheet would want, for the CSV route. It is a READ: the
 * table has a SELECT policy for staff and no write policy, so there is no
 * honest "add a screen by hand" here and none is offered.
 *
 * The handoff package is the same idea for `design_assets` (kind, model,
 * rights note — never the base64, which is a picture and not a record),
 * the theme options' Figma references and previews, the locked handoff, and
 * every deliverable's artifact URL. A JSON route serves it.
 */

export type ScreenInventoryRow = {
  id: string;
  screenKey: string;
  name: string;
  status: string;
  userRole: string;
  purpose: string | null;
  entryPoint: string | null;
  exitAction: string | null;
  requiredSections: string | null;
  requiredData: string | null;
  actions: string | null;
  validation: string | null;
  dependencies: string | null;
  responsiveBehaviour: string | null;
  accessibilityNotes: string | null;
  permissionBehaviour: string | null;
  hasEmptyState: boolean;
  hasLoadingState: boolean;
  hasErrorState: boolean;
  hasSuccessState: boolean;
  baselineVersion: number | null;
  scopeItems: string[];
  createdAt: string;
  updatedAt: string;
};

export async function listScreenInventory(projectId: string): Promise<ScreenInventoryRow[]> {
  const supabase = await createClient();

  const { data: screens, error: screensError } = await supabase
    .schema('projects')
    .from('screens')
    .select(
      'id, screen_key, name, status, user_role, purpose, entry_point, exit_action, required_sections, required_data, actions, validation, dependencies, responsive_behaviour, accessibility_notes, permission_behaviour, has_empty_state, has_loading_state, has_error_state, has_success_state, baseline_version, created_at, updated_at',
    )
    .eq('project_id', projectId)
    .order('screen_key', { ascending: true });
  if (screensError) unreadable('listScreenInventory.screens', screensError);

  const rows = screens ?? [];
  if (rows.length === 0) return [];

  const { data: links, error: linksError } = await supabase
    .schema('projects')
    .from('screen_scope_items')
    .select('screen_id, scope_item_id')
    .in(
      'screen_id',
      rows.map((s) => s.id),
    );
  if (linksError) unreadable('listScreenInventory.links', linksError);

  const scopeItemIds = [...new Set((links ?? []).map((l) => l.scope_item_id))];
  const scopeTitle = new Map<string, string>();
  if (scopeItemIds.length > 0) {
    const { data: items, error: itemsError } = await supabase.schema('projects').from('scope_items').select('id, title').in('id', scopeItemIds);
    if (itemsError) unreadable('listScreenInventory.scopeItems', itemsError);
    for (const i of items ?? []) scopeTitle.set(i.id, i.title);
  }
  const titlesByScreen = new Map<string, string[]>();
  for (const l of links ?? []) {
    const list = titlesByScreen.get(l.screen_id) ?? [];
    list.push(scopeTitle.get(l.scope_item_id) ?? l.scope_item_id);
    titlesByScreen.set(l.screen_id, list);
  }

  return rows.map((s) => ({
    id: s.id,
    screenKey: s.screen_key,
    name: s.name,
    status: s.status,
    userRole: s.user_role,
    purpose: s.purpose,
    entryPoint: s.entry_point,
    exitAction: s.exit_action,
    requiredSections: s.required_sections,
    requiredData: s.required_data,
    actions: s.actions,
    validation: s.validation,
    dependencies: s.dependencies,
    responsiveBehaviour: s.responsive_behaviour,
    accessibilityNotes: s.accessibility_notes,
    permissionBehaviour: s.permission_behaviour,
    hasEmptyState: s.has_empty_state,
    hasLoadingState: s.has_loading_state,
    hasErrorState: s.has_error_state,
    hasSuccessState: s.has_success_state,
    baselineVersion: s.baseline_version,
    scopeItems: titlesByScreen.get(s.id) ?? [],
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }));
}

export type DesignHandoffPackage = {
  projectId: string;
  generatedAt: string;
  assets: { id: string; kind: string; model: string; mediaType: string; prompt: string; rightsNote: string; createdAt: string }[];
  themes: {
    id: string;
    name: string;
    optionIndex: number;
    version: number;
    adminStatus: string;
    clientStatus: string;
    figma: { fileKey: string | null; nodeId: string | null; nodeName: string | null; version: string | null; verifiedAt: string | null };
    previewAssetUrl: string | null;
  }[];
  handoff: { themeOptionId: string; colorOptionId: string; figmaNodeId: string | null; figmaVersion: string | null; lockedAt: string; phaseFourReady: boolean } | null;
  artifacts: { id: string; kind: string; version: number; title: string; status: string; artifactUrl: string }[];
};

export async function readDesignHandoffPackage(projectId: string): Promise<DesignHandoffPackage> {
  const supabase = await createClient();

  const [assets, themes, handoff, deliverables] = await Promise.all([
    supabase
      .schema('projects')
      .from('design_assets')
      .select('id, kind, model, media_type, prompt, rights_note, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
    supabase
      .schema('projects')
      .from('theme_options')
      .select('id, name, option_index, version, admin_status, client_status, figma_file_key, figma_node_id, figma_node_name, figma_version, figma_verified_at, preview_asset_url')
      .eq('project_id', projectId)
      .order('option_index', { ascending: true }),
    supabase
      .schema('projects')
      .from('phase_three_handoffs')
      .select('theme_option_id, color_option_id, figma_node_id, figma_version, locked_at, phase_four_ready')
      .eq('project_id', projectId)
      .order('locked_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .schema('projects')
      .from('deliverables')
      .select('id, kind, version, title, status, artifact_url')
      .eq('project_id', projectId)
      .not('artifact_url', 'is', null)
      .order('kind', { ascending: true })
      .order('version', { ascending: false }),
  ]);
  if (assets.error) unreadable('readDesignHandoffPackage.assets', assets.error);
  if (themes.error) unreadable('readDesignHandoffPackage.themes', themes.error);
  if (handoff.error) unreadable('readDesignHandoffPackage.handoff', handoff.error);
  if (deliverables.error) unreadable('readDesignHandoffPackage.deliverables', deliverables.error);

  return {
    projectId,
    generatedAt: new Date().toISOString(),
    assets: (assets.data ?? []).map((a) => ({
      id: a.id,
      kind: a.kind,
      model: a.model,
      mediaType: a.media_type,
      prompt: a.prompt,
      rightsNote: a.rights_note,
      createdAt: a.created_at,
    })),
    themes: (themes.data ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      optionIndex: t.option_index,
      version: t.version,
      adminStatus: t.admin_status,
      clientStatus: t.client_status,
      figma: { fileKey: t.figma_file_key, nodeId: t.figma_node_id, nodeName: t.figma_node_name, version: t.figma_version, verifiedAt: t.figma_verified_at },
      previewAssetUrl: t.preview_asset_url,
    })),
    handoff: handoff.data
      ? {
          themeOptionId: handoff.data.theme_option_id,
          colorOptionId: handoff.data.color_option_id,
          figmaNodeId: handoff.data.figma_node_id,
          figmaVersion: handoff.data.figma_version,
          lockedAt: handoff.data.locked_at,
          phaseFourReady: handoff.data.phase_four_ready,
        }
      : null,
    artifacts: (deliverables.data ?? [])
      .filter((d): d is typeof d & { artifact_url: string } => d.artifact_url !== null)
      .map((d) => ({ id: d.id, kind: d.kind, version: d.version, title: d.title, status: d.status, artifactUrl: d.artifact_url })),
  };
}
