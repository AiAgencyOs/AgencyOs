'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { DESIGN_ASSET_KINDS, type DesignAssetKind } from './design-asset-schema';
import { markDesignAssetApproved, uploadDesignAsset } from './design-asset-service';

/** SCR-032/033/038 — upload a design asset (or a new version of one) and mark one approved. */

function revalidateDesign(projectId: string) {
  revalidatePath(`/projects/${projectId}/design`);
  revalidatePath(`/projects/${projectId}/design/colors`);
  revalidatePath(`/projects/${projectId}/design/screens`);
}

export async function uploadDesignAssetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const kind = String(formData.get('kind') ?? '');
  const file = formData.get('file');
  const result = await uploadDesignAsset(
    {
      projectId,
      kind: (DESIGN_ASSET_KINDS as readonly string[]).includes(kind) ? (kind as DesignAssetKind) : ('' as DesignAssetKind),
      title: String(formData.get('title') ?? ''),
      parentAssetId: String(formData.get('parentAssetId') ?? '').trim() || undefined,
    },
    file instanceof File ? file : null,
  );
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateDesign(projectId);
  return { status: 'success', message: result.data.version > 1 ? `Uploaded as version ${result.data.version}.` : 'Asset uploaded as a draft.' };
}

export async function markDesignAssetApprovedAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await markDesignAssetApproved({ projectId, assetId: String(formData.get('assetId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidateDesign(projectId);
  return { status: 'success', message: 'Asset marked approved.' };
}
