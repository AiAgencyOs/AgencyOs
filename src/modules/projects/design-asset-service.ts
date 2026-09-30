import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { filesBucket, MAX_UPLOAD_BYTES, probeStorage, safeObjectName } from '@/lib/files/storage';
import { err, ok, type Result } from '@/lib/result';

import {
  DESIGN_ASSET_MEDIA_TYPES,
  markDesignAssetApprovedSchema,
  uploadDesignAssetSchema,
  type MarkDesignAssetApprovedInput,
  type UploadDesignAssetInput,
} from './design-asset-schema';

/**
 * SCR-038 — the asset lifecycle's doors (migration 20261001130000).
 *
 * `project.write` throughout — the capability every other Phase 3 decision
 * takes — and `core.can_manage_delivery()` again inside the functions. Upload
 * puts the object in the project-files bucket (bucket E's storage) FIRST and
 * records the row through `projects.record_uploaded_design_asset` second; a
 * row the database refuses removes the object again, so nothing claims a
 * body that is not there and nothing sits in storage that no row names.
 * Storage that cannot be reached refuses with the probe's own sentence.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function uploadDesignAsset(
  input: UploadDesignAssetInput,
  file: File | null,
): Promise<Result<{ assetId: string; version: number }>> {
  const parsed = uploadDesignAssetSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid upload.');
  if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) return err('VALIDATION', 'Choose a file to upload.');
  if (file.size > MAX_UPLOAD_BYTES) return err('VALIDATION', `That file is ${Math.round(file.size / 1024 / 1024)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  const mediaType = file.type;
  if (!(DESIGN_ASSET_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    return err('VALIDATION', 'A design asset is a PNG, JPEG, WebP, SVG or PDF, or a WOFF, WOFF2, TTF or OTF font.');
  }

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to upload a design asset.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const storage = await probeStorage(supabase, context.organizationId);
  if (!storage.reachable) return err('PROVIDER_ERROR', `Storage is not reachable, so nothing was uploaded. ${storage.reason}`);

  const objectKey = crypto.randomUUID();
  const path = `${context.organizationId}/${parsed.data.projectId}/design-assets/${objectKey}/${safeObjectName(file.name)}`;

  const { error: uploadError } = await supabase.storage.from(filesBucket()).upload(path, file, { contentType: mediaType, upsert: false });
  if (uploadError) {
    log('uploadDesignAsset.object', uploadError.message);
    return err('PROVIDER_ERROR', `Storage refused the upload: ${uploadError.message}`);
  }

  const { data, error } = await supabase.schema('projects').rpc('record_uploaded_design_asset', {
    p_project_id: parsed.data.projectId,
    p_kind: parsed.data.kind,
    p_title: parsed.data.title || file.name,
    p_storage_path: path,
    p_media_type: mediaType,
    p_size_bytes: file.size,
    p_parent_asset_id: parsed.data.parentAssetId,
    p_licence: parsed.data.licence || undefined,
  });
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; asset_id?: string | null; version?: number | null } | undefined;

  if (error || row?.outcome !== 'recorded' || !row.asset_id) {
    // The row was refused: take the object back out so storage holds nothing unnamed.
    const { error: removeError } = await supabase.storage.from(filesBucket()).remove([path]);
    if (removeError) log('uploadDesignAsset.remove', removeError.message);
    if (error) {
      log('uploadDesignAsset.record', error.message);
      return err('INTERNAL', 'Storage took the file but the database refused the record, so the upload was undone.');
    }
    switch (row?.outcome) {
      case 'forbidden':
        return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may upload a design asset.');
      case 'not_found':
        return err('NOT_FOUND', 'Project not found.');
      case 'no_phase_three':
        return err('CONFLICT', 'Phase 3 has not started for this project, so there is no design to attach an asset to.');
      case 'licence_too_long':
        return err('VALIDATION', 'A licence note is at most 500 characters.');
      case 'bad_kind':
        return err('VALIDATION', 'That is not an asset kind.');
      case 'parent_not_found':
        return err('NOT_FOUND', 'The asset this replaces was not found on this project.');
      case 'parent_is_a_version':
        return err('VALIDATION', 'A replacement is added to the first version, not to another version.');
      default:
        return err('INTERNAL', 'Could not record the asset; the upload was undone.');
    }
  }

  return ok({ assetId: row.asset_id, version: row.version ?? 1 });
}

export async function markDesignAssetApproved(input: MarkDesignAssetApprovedInput): Promise<Result<{ approved: true }>> {
  const parsed = markDesignAssetApprovedSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid asset.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to approve a design asset.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('mark_design_asset_approved', { p_asset_id: parsed.data.assetId });
  if (error) {
    log('markDesignAssetApproved', error.message);
    return err('INTERNAL', 'Could not approve the asset.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'approved':
      return ok({ approved: true });
    case 'already_approved':
      return err('CONFLICT', 'This version is already approved.');
    case 'not_found':
      return err('NOT_FOUND', 'Asset not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may approve an asset.');
    default:
      return err('INTERNAL', 'Could not approve the asset.');
  }
}
