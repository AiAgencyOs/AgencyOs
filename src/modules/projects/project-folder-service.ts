import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { createProjectFolderSchema, fileIntoFolderSchema, folderPathProblem, type CreateProjectFolderInput, type FileIntoFolderInput } from './project-folder-schema';

/** The two folder doors of migration 20261005100400. `project.write` here (as the file doors), `core.can_write()` again inside. */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}
const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

export async function createProjectFolder(input: CreateProjectFolderInput): Promise<Result<{ folderId: string; path: string }>> {
  const parsed = createProjectFolderSchema.safeParse(input);
  if (!parsed.success) {
    const cleaned = typeof input.path === 'string' ? input.path.split('/').map((s) => s.trim()).filter(Boolean).join('/') : '';
    return err('VALIDATION', folderPathProblem(cleaned) ?? parsed.error.issues[0]?.message ?? 'Invalid folder.');
  }
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to add a folder.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('create_project_folder', {
    p_project_id: parsed.data.projectId,
    p_category: parsed.data.category,
    p_path: parsed.data.path,
  });
  if (error) {
    log('createProjectFolder', error.message);
    return err('INTERNAL', 'Could not create the folder.');
  }
  const row = first<{ outcome?: string; folder_id?: string | null }>(data);
  switch (row?.outcome) {
    case 'created':
      return row.folder_id ? ok({ folderId: row.folder_id, path: parsed.data.path }) : err('INTERNAL', 'Could not create the folder.');
    case 'exists':
      return err('CONFLICT', 'That folder already exists in this category.');
    case 'invalid_path':
      return err('VALIDATION', 'That is not a usable folder name.');
    case 'invalid_category':
      return err('VALIDATION', 'Pick one of the file categories.');
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not add a folder.');
    default:
      return err('INTERNAL', 'Could not create the folder.');
  }
}

export async function fileIntoFolder(input: FileIntoFolderInput): Promise<Result<{ path: string }>> {
  const parsed = fileIntoFolderSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid file or folder.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to move a file.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('file_into_folder', { p_file_id: parsed.data.fileId, p_path: parsed.data.path });
  if (error) {
    log('fileIntoFolder', error.message);
    return err('INTERNAL', 'Could not file the file.');
  }
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'filed':
    case 'unchanged':
      return ok({ path: parsed.data.path });
    case 'no_such_folder':
      return err('NOT_FOUND', 'That folder does not exist in the file’s category. Create it first.');
    case 'not_found':
      return err('NOT_FOUND', 'File not found (or it is in the trash).');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: your role may not move a file.');
    default:
      return err('INTERNAL', 'Could not file the file.');
  }
}
