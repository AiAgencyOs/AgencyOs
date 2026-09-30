import { z } from 'zod';

import { PROJECT_FILE_CATEGORIES } from './schema';

/**
 * Stored project files — decision 5 of 2026-09-29 (migration 20260930110000).
 * Upload, a new version, the trash and its restore, and share links. The
 * link-based doors (`addProjectFileSchema` and friends) stay in schema.ts;
 * a linked file and a stored file are rows of the same table.
 */

export const uploadProjectFileSchema = z.object({
  projectId: z.uuid(),
  category: z.enum(PROJECT_FILE_CATEGORIES).default('documents'),
  /** Blank means "use the file's own name". */
  title: z.string().trim().max(200).default(''),
  description: z.string().trim().max(1000).default(''),
  /** Set when the upload is a new version of an existing file (its first-version row). */
  parentFileId: z.uuid().optional(),
});

export const trashProjectFileSchema = z.object({ fileId: z.uuid() });
export const restoreProjectFileSchema = z.object({ fileId: z.uuid() });

/** How long a share link stands. Bounded: a link that never expires is a leak with a delay. */
export const SHARE_EXPIRY_DAYS = [1, 7, 30, 90] as const;

export const createFileShareSchema = z.object({
  fileId: z.uuid(),
  expiresInDays: z.coerce.number().int().refine((d) => (SHARE_EXPIRY_DAYS as readonly number[]).includes(d), 'Pick one of the offered expiries.'),
});

export const revokeFileShareSchema = z.object({ shareId: z.uuid() });

export type UploadProjectFileInput = z.input<typeof uploadProjectFileSchema>;
export type TrashProjectFileInput = z.input<typeof trashProjectFileSchema>;
export type RestoreProjectFileInput = z.input<typeof restoreProjectFileSchema>;
export type CreateFileShareInput = z.input<typeof createFileShareSchema>;
export type RevokeFileShareInput = z.input<typeof revokeFileShareSchema>;
