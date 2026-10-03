import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Saved views — a name for one list screen's own `?query=string`, nothing
 * more. See the migration (`20260928150000_a_filter_worth_keeping.sql`) for
 * why this table never parses what it stores: the owning page is the only
 * thing that ever needs to understand its own filters, and it already does,
 * for a typed URL.
 */
export type SavedView = { id: string; name: string; query: string };

export async function listSavedViews(page: string): Promise<SavedView[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('saved_views')
    .select('id, name, query')
    .eq('page', page)
    .order('created_at', { ascending: true });

  if (error) unreadable('listSavedViews', error);

  return data ?? [];
}

/**
 * Saves a view under `name`, replacing an existing one of the same name on
 * the same page (case-insensitive, matching the migration's unique index) —
 * a swap done as delete-then-insert rather than an upsert, since a saved view
 * has no update policy at all (see the migration).
 *
 * `organizationId`/`userId` come from the caller's already-resolved
 * `requireInternal()` context rather than a second round trip to re-derive
 * them here.
 */
export async function saveView(
  page: string,
  name: string,
  query: string,
  organizationId: string,
  userId: string,
): Promise<void> {
  const supabase = await createClient();
  const trimmedName = name.trim();

  const { error: deleteError } = await supabase
    .schema('core')
    .from('saved_views')
    .delete()
    .eq('page', page)
    .eq('user_id', userId)
    .ilike('name', trimmedName);

  if (deleteError) unreadable('saveView.replace', deleteError);

  const { error: insertError } = await supabase
    .schema('core')
    .from('saved_views')
    .insert({ page, name: trimmedName, query, user_id: userId, organization_id: organizationId });

  if (insertError) unreadable('saveView.insert', insertError);
}

export async function deleteSavedView(id: string): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase.schema('core').from('saved_views').delete().eq('id', id);

  if (error) unreadable('deleteSavedView', error);
}
