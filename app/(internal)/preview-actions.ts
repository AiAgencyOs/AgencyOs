'use server';

import { readEntityPreview } from '@/lib/admin/entity-preview';
import { isPreviewGroup, type EntityPreview } from '@/lib/admin/entity-preview-types';
import { err, type Result } from '@/lib/result';

/**
 * The quick-preview drawer's read — SCR-002 (bucket F, stream F-A). One
 * action for every entity the search matches; the reader decides the
 * capability per group and RLS decides the row.
 */
export async function previewEntityAction(group: string, id: string): Promise<Result<EntityPreview>> {
  if (!isPreviewGroup(group)) return err('VALIDATION', 'This kind of record has no preview.');
  return readEntityPreview(group, id);
}
