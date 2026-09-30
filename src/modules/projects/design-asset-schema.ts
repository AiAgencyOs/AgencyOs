import { z } from 'zod';

/**
 * SCR-038 — a design asset has a state (migration 20261001130000): uploaded
 * as a first version or a replacement, and marked approved. The body lives
 * in Supabase Storage; the row is written after the object landed.
 */

export const DESIGN_ASSET_KINDS = ['illustration', 'reference', 'texture', 'mood_board', 'visual_asset'] as const;
export type DesignAssetKind = (typeof DESIGN_ASSET_KINDS)[number];

export const DESIGN_ASSET_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf'] as const;

export const uploadDesignAssetSchema = z.object({
  projectId: z.uuid(),
  kind: z.enum(DESIGN_ASSET_KINDS),
  title: z.string().trim().max(200).default(''),
  /** The first version this upload replaces; absent for a first version. */
  parentAssetId: z.uuid().optional(),
});
export type UploadDesignAssetInput = z.input<typeof uploadDesignAssetSchema>;

export const markDesignAssetApprovedSchema = z.object({
  projectId: z.uuid(),
  assetId: z.uuid(),
});
export type MarkDesignAssetApprovedInput = z.infer<typeof markDesignAssetApprovedSchema>;
