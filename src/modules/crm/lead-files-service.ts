import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

import { addLeadFileSchema, removeLeadFileSchema, type AddLeadFileInput, type RemoveLeadFileInput } from './lead-files-schema';

export type LeadFile = {
  id: string;
  title: string;
  url: string;
  addedAt: string;
  addedByName: string | null;
  carriedToProjectId: string | null;
};

/** A lead's kept links, newest first. A failed read refuses; it is never an empty list. */
export async function readLeadFiles(leadId: string): Promise<LeadFile[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('lead_files')
    .select('id, title, url, added_at, added_by, carried_to_project_id')
    .eq('lead_id', leadId)
    .order('added_at', { ascending: false });
  if (error) unreadable('readLeadFiles', error);

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.added_by).filter((id): id is string => id !== null))];
  const { data: users, error: usersError } =
    userIds.length > 0
      ? await supabase.schema('core').from('users').select('id, full_name, email').in('id', userIds)
      : { data: [] as { id: string; full_name: string | null; email: string }[], error: null };
  if (usersError) unreadable('readLeadFiles.users', usersError);
  const nameById = new Map((users ?? []).map((u) => [u.id, u.full_name ?? u.email]));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    addedAt: r.added_at,
    addedByName: r.added_by ? (nameById.get(r.added_by) ?? null) : null,
    carriedToProjectId: r.carried_to_project_id,
  }));
}

const ADD_REFUSALS: Record<string, string> = {
  no_actor: 'Sign in again to add a file.',
  not_authorized: 'Only an owner or ops admin can keep files on a lead.',
  not_found: 'Lead not found.',
  invalid_title: 'A file needs a title of up to 200 characters.',
  invalid_url: 'Paste a full link starting with https://',
  duplicate: 'That link is already on this lead.',
};

export async function addLeadFile(input: AddLeadFileInput): Promise<Result<{ fileId: string }>> {
  const parsed = addLeadFileSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid file.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }
  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to add a file to a lead.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .rpc('add_lead_file', { p_lead_id: parsed.data.leadId, p_title: parsed.data.title, p_url: parsed.data.url });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addLeadFile', detail: error.message }));
    return err('INTERNAL', 'Could not add the file.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; file_id?: string | null } | undefined;
  if (row?.outcome === 'added' && row.file_id) return ok({ fileId: row.file_id });
  const message = ADD_REFUSALS[row?.outcome ?? ''];
  if (message) return err(row?.outcome === 'not_authorized' || row?.outcome === 'no_actor' ? 'FORBIDDEN' : row?.outcome === 'duplicate' ? 'CONFLICT' : row?.outcome === 'not_found' ? 'NOT_FOUND' : 'VALIDATION', message);
  return err('INTERNAL', 'Could not add the file.');
}

export async function removeLeadFile(input: RemoveLeadFileInput): Promise<Result<{ removed: true }>> {
  const parsed = removeLeadFileSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid file.');
  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to remove a lead file.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('remove_lead_file', { p_file_id: parsed.data.fileId });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'removeLeadFile', detail: error.message }));
    return err('INTERNAL', 'Could not remove the file.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  if (row?.outcome === 'removed') return ok({ removed: true });
  if (row?.outcome === 'not_found') return err('NOT_FOUND', 'That file is already gone.');
  if (row?.outcome === 'not_authorized' || row?.outcome === 'no_actor') return err('FORBIDDEN', 'Only an owner or ops admin can remove a lead file.');
  return err('INTERNAL', 'Could not remove the file.');
}
