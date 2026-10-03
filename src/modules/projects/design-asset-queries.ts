import 'server-only';

import { createClient } from '@/lib/db/server';
import { filesBucket, probeStorage, SIGNED_URL_SECONDS } from '@/lib/files/storage';
import { unreadable } from '@/lib/result';

/**
 * SCR-038 — every design asset of a project with its state, its version and
 * a way to see it: a generated asset carries its image inline, an uploaded
 * one a signed URL (five minutes) from storage — or, when storage cannot be
 * reached, the reason in words and no URL, never a broken picture that
 * reads as "the asset is gone".
 */

export type DesignAssetVersion = {
  id: string;
  kind: string;
  origin: 'generated' | 'uploaded';
  status: 'draft' | 'approved';
  version: number;
  /** The first version this belongs to (itself for a first version). */
  familyId: string;
  title: string;
  prompt: string | null;
  model: string | null;
  rightsNote: string | null;
  mediaType: string;
  /** `data:` for a generated asset, a signed URL for an uploaded one, null when storage is unreachable. */
  previewUrl: string | null;
  sizeBytes: number | null;
  uploadedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
};

export type DesignAssetsRead = {
  assets: DesignAssetVersion[];
  /** Families: the first version and its replacements, newest version first. */
  families: { familyId: string; kind: string; title: string; latest: DesignAssetVersion; versions: DesignAssetVersion[] }[];
  approved: number;
  draft: number;
  uploaded: number;
  generated: number;
  storage: { reachable: boolean; reason: string | null };
};

type Row = {
  id: string;
  kind: string;
  origin: string;
  status: string;
  version: number;
  parent_asset_id: string | null;
  title: string | null;
  prompt: string | null;
  model: string | null;
  rights_note: string | null;
  media_type: string;
  image_base64: string | null;
  storage_path: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  approved_at: string | null;
  created_at: string;
};

export async function readDesignAssetVersions(projectId: string, organizationId: string | null): Promise<DesignAssetsRead> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('design_assets')
    .select('id, kind, origin, status, version, parent_asset_id, title, prompt, model, rights_note, media_type, image_base64, storage_path, size_bytes, uploaded_by, approved_at, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) unreadable('readDesignAssetVersions', error);
  const rows = (data ?? []) as Row[];

  const uploadedRows = rows.filter((r) => r.origin === 'uploaded' && r.storage_path);
  let storage: DesignAssetsRead['storage'] = { reachable: true, reason: null };
  const signed = new Map<string, string>();
  if (uploadedRows.length > 0) {
    const probe = await probeStorage(supabase, organizationId ?? projectId);
    if (!probe.reachable) {
      storage = { reachable: false, reason: probe.reason };
    } else {
      const { data: urls, error: signError } = await supabase.storage
        .from(filesBucket())
        .createSignedUrls(uploadedRows.map((r) => r.storage_path as string), SIGNED_URL_SECONDS);
      if (signError) {
        storage = { reachable: false, reason: `Storage would not sign a URL: ${signError.message}` };
      } else {
        for (const u of urls ?? []) if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
      }
    }
  }

  const assets: DesignAssetVersion[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    origin: r.origin === 'uploaded' ? 'uploaded' : 'generated',
    status: r.status === 'approved' ? 'approved' : 'draft',
    version: r.version,
    familyId: r.parent_asset_id ?? r.id,
    title: r.title ?? (r.prompt ? r.prompt.slice(0, 80) : r.kind.replace(/_/g, ' ')),
    prompt: r.prompt,
    model: r.model,
    rightsNote: r.rights_note,
    mediaType: r.media_type,
    previewUrl:
      r.origin === 'uploaded'
        ? (r.storage_path ? (signed.get(r.storage_path) ?? null) : null)
        : r.image_base64
          ? `data:${r.media_type};base64,${r.image_base64}`
          : null,
    sizeBytes: r.size_bytes,
    uploadedBy: r.uploaded_by,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
  }));

  const byFamily = new Map<string, DesignAssetVersion[]>();
  for (const a of assets) byFamily.set(a.familyId, [...(byFamily.get(a.familyId) ?? []), a]);
  const families = [...byFamily.entries()].map(([familyId, versions]) => {
    const sorted = [...versions].sort((a, b) => b.version - a.version);
    const latest = sorted[0]!;
    const first = sorted[sorted.length - 1]!;
    return { familyId, kind: first.kind, title: first.title, latest, versions: sorted };
  });

  return {
    assets,
    families,
    approved: assets.filter((a) => a.status === 'approved').length,
    draft: assets.filter((a) => a.status === 'draft').length,
    uploaded: assets.filter((a) => a.origin === 'uploaded').length,
    generated: assets.filter((a) => a.origin === 'generated').length,
    storage,
  };
}
