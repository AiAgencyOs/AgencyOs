import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-034 — the requirement links per screen: how many scope items each
 * screen of a project is mapped to (`projects.screen_scope_items`), so the
 * inventory can show the link count on the row rather than only on the
 * detail page. Read only; a failed read refuses.
 */
export async function countScopeLinksByScreen(projectId: string): Promise<Map<string, number>> {
  const supabase = await createClient();
  const { data: screens, error: screensError } = await supabase.schema('projects').from('screens').select('id').eq('project_id', projectId);
  if (screensError) unreadable('countScopeLinksByScreen.screens', screensError);
  const ids = (screens ?? []).map((s) => s.id);
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase.schema('projects').from('screen_scope_items').select('screen_id').in('screen_id', ids);
  if (error) unreadable('countScopeLinksByScreen', error);
  const out = new Map<string, number>();
  for (const row of (data ?? []) as { screen_id: string }[]) out.set(row.screen_id, (out.get(row.screen_id) ?? 0) + 1);
  return out;
}
