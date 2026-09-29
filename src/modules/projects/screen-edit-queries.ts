import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads for the screen inventory's controls (SCR-032/034/035/038,
 * migration 20260929200000): whether the list is open, what a screen can
 * be mapped to, and which reference asset is linked where. Pure and
 * RLS-scoped; every failed read refuses.
 */

export type ScreenListState = {
  /** The latest screen baseline, or null when none has been drafted. */
  latest: { id: string; version: number; status: string } | null;
  /** True while a person may change the list: no baseline yet, or the latest is draft/review. */
  open: boolean;
  /** The sentence the row trigger raises, when closed. */
  closedBy: string | null;
};

export async function readScreenListState(projectId: string): Promise<ScreenListState> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('screen_baselines')
    .select('id, version, status')
    .eq('project_id', projectId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) unreadable('readScreenListState', error);

  if (!data) return { latest: null, open: true, closedBy: null };
  const open = data.status === 'draft' || data.status === 'review';
  return {
    latest: { id: data.id, version: data.version, status: data.status },
    open,
    closedBy: open ? null : `screen baseline v${data.version} is ${data.status}`,
  };
}

export type MappableScopeItem = { id: string; title: string; inclusion: string; scopeVersion: number };

/**
 * The items of the ACTIVE scope version a screen may be mapped to — never an
 * excluded one, which the row trigger refuses anyway (Doc 12 §20).
 */
export async function listMappableScopeItems(projectId: string): Promise<MappableScopeItem[]> {
  const supabase = await createClient();
  const { data: version, error: versionError } = await supabase
    .schema('projects')
    .from('scope_versions')
    .select('id, version')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (versionError) unreadable('listMappableScopeItems.version', versionError);
  if (!version) return [];

  const { data, error } = await supabase
    .schema('projects')
    .from('scope_items')
    .select('id, title, inclusion')
    .eq('scope_version_id', version.id)
    .neq('inclusion', 'excluded')
    .order('position', { ascending: true });
  if (error) unreadable('listMappableScopeItems.items', error);
  return (data ?? []).map((i) => ({ id: i.id, title: i.title, inclusion: i.inclusion, scopeVersion: version.version }));
}

export type DesignAssetLink = {
  id: string;
  assetId: string;
  screenId: string | null;
  uiVersionId: string | null;
  /** Where it is linked, in words: the screen's name and key, or "UI version N". */
  targetLabel: string;
  createdAt: string;
};

/** Every asset link in a project, with its target named. */
export async function listDesignAssetLinks(projectId: string): Promise<DesignAssetLink[]> {
  const supabase = await createClient();

  const { data: assets, error: assetsError } = await supabase.schema('projects').from('design_assets').select('id').eq('project_id', projectId);
  if (assetsError) unreadable('listDesignAssetLinks.assets', assetsError);
  const assetIds = (assets ?? []).map((a) => a.id);
  if (assetIds.length === 0) return [];

  const { data: links, error: linksError } = await supabase
    .schema('projects')
    .from('design_asset_links')
    .select('id, asset_id, screen_id, ui_version_id, created_at')
    .in('asset_id', assetIds)
    .order('created_at', { ascending: true });
  if (linksError) unreadable('listDesignAssetLinks.links', linksError);
  const rows = links ?? [];
  if (rows.length === 0) return [];

  const screenIds = [...new Set(rows.map((l) => l.screen_id).filter((v): v is string => v !== null))];
  const versionIds = [...new Set(rows.map((l) => l.ui_version_id).filter((v): v is string => v !== null))];

  const [screens, versions] = await Promise.all([
    screenIds.length > 0
      ? supabase.schema('projects').from('screens').select('id, name, screen_key').in('id', screenIds)
      : Promise.resolve({ data: [], error: null }),
    versionIds.length > 0
      ? supabase.schema('projects').from('ui_versions').select('id, version').in('id', versionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (screens.error) unreadable('listDesignAssetLinks.screens', screens.error);
  if (versions.error) unreadable('listDesignAssetLinks.versions', versions.error);

  const screenLabel = new Map((screens.data ?? []).map((s) => [s.id, `${s.name} (${s.screen_key})`]));
  const versionLabel = new Map((versions.data ?? []).map((v) => [v.id, `UI version ${v.version}`]));

  return rows.map((l) => ({
    id: l.id,
    assetId: l.asset_id,
    screenId: l.screen_id,
    uiVersionId: l.ui_version_id,
    targetLabel:
      (l.screen_id ? screenLabel.get(l.screen_id) : l.ui_version_id ? versionLabel.get(l.ui_version_id) : undefined) ?? 'A row this reader may not see',
    createdAt: l.created_at,
  }));
}

export type UiVersionOption = { id: string; version: number; status: string };

/** The UI versions an asset may be linked to. */
export async function listUiVersionOptions(projectId: string): Promise<UiVersionOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('ui_versions')
    .select('id, version, status')
    .eq('project_id', projectId)
    .order('version', { ascending: false });
  if (error) unreadable('listUiVersionOptions', error);
  return (data ?? []).map((v) => ({ id: v.id, version: v.version, status: v.status }));
}

export type ScreenAsset = {
  linkId: string;
  assetId: string;
  kind: string;
  prompt: string;
  imageBase64: string;
  mediaType: string;
  createdAt: string;
};

/** The reference assets linked to one screen, with the image for a thumbnail. */
export async function listScreenAssets(screenId: string): Promise<ScreenAsset[]> {
  const supabase = await createClient();
  const { data: links, error: linksError } = await supabase
    .schema('projects')
    .from('design_asset_links')
    .select('id, asset_id, created_at')
    .eq('screen_id', screenId)
    .order('created_at', { ascending: true });
  if (linksError) unreadable('listScreenAssets.links', linksError);
  const rows = links ?? [];
  if (rows.length === 0) return [];

  const { data: assets, error: assetsError } = await supabase
    .schema('projects')
    .from('design_assets')
    .select('id, kind, prompt, image_base64, media_type')
    .in('id', rows.map((l) => l.asset_id));
  if (assetsError) unreadable('listScreenAssets.assets', assetsError);
  const byId = new Map((assets ?? []).map((a) => [a.id, a]));

  return rows.flatMap((l) => {
    const a = byId.get(l.asset_id);
    if (!a) return [];
    return [{ linkId: l.id, assetId: a.id, kind: a.kind, prompt: a.prompt, imageBase64: a.image_base64, mediaType: a.media_type, createdAt: l.created_at }];
  });
}

export type DesignAssetOption = { id: string; kind: string; prompt: string; createdAt: string };

/** Every reference asset of a project, without the image — for a picker. */
export async function listDesignAssetOptions(projectId: string): Promise<DesignAssetOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('design_assets')
    .select('id, kind, prompt, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) unreadable('listDesignAssetOptions', error);
  return (data ?? []).map((a) => ({ id: a.id, kind: a.kind, prompt: a.prompt, createdAt: a.created_at }));
}
