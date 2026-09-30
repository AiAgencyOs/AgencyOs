'use server';

import { revalidatePath } from 'next/cache';

import { editSearch, forgetSearch, listMySearches, normalizeFilters, recordSearch, saveSearch, type SavedSearch } from '@/lib/admin/saved-searches';
import { getAuthContext } from '@/lib/auth/session';
import { isInternalRole } from '@/lib/auth/claims';
import type { FormState } from '@/modules/identity/types';

/**
 * SCR-002's recent / saved searches. `recordSearchAction` is called by the
 * results page after it renders (a GET must not write); the two forms and
 * the palette's read use the rest.
 */
export async function recordSearchAction(query: string, filters: { type?: string; since?: string; f?: string[] }): Promise<void> {
  const result = await recordSearch(query, normalizeFilters(filters));
  if (result.ok) revalidatePath('/search');
}

export async function listMySearchesAction(): Promise<{ saved: SavedSearch[]; recent: SavedSearch[] }> {
  const context = await getAuthContext();
  if (!context || !isInternalRole(context.role)) return { saved: [], recent: [] };
  return listMySearches();
}

export async function saveSearchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const query = String(formData.get('q') ?? '');
  const filters = normalizeFilters({ type: String(formData.get('type') ?? ''), since: String(formData.get('since') ?? ''), f: formData.getAll('f').map(String) });
  const result = await saveSearch(query, filters, String(formData.get('name') ?? ''));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/search');
  return { status: 'success', message: 'Saved.' };
}

export async function forgetSearchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get('id') ?? '');
  if (!id) return { status: 'error', message: 'Missing search id.' };
  const result = await forgetSearch(id);
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/search');
  return { status: 'success', message: 'Removed.' };
}

export async function editSearchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await editSearch(String(formData.get('id') ?? ''), { name: String(formData.get('name') ?? ''), query: String(formData.get('q') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/search');
  return { status: 'success', message: 'Saved.' };
}
