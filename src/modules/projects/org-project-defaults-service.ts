import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { parseFolderLines, setOrgProjectDefaultsSchema, type SetOrgProjectDefaultsInput } from './org-project-defaults-schema';

/** `projects.set_project_defaults` (owner / ops admin, audited `project_defaults.updated`). */
export async function setOrgProjectDefaults(input: SetOrgProjectDefaultsInput): Promise<Result<{ folders: number; phases: number }>> {
  const parsed = setOrgProjectDefaultsSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid defaults.');
  const { folders, problem } = parseFolderLines(parsed.data.folderText);
  if (problem) return err('VALIDATION', problem);

  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to change the organisation’s project defaults.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_project_defaults', { p_watch_phases: parsed.data.watchPhases, p_folders: folders });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setOrgProjectDefaults', detail: error.message }));
    return err('INTERNAL', 'Could not save the project defaults.');
  }
  switch ((Array.isArray(data) ? data[0] : data)?.outcome) {
    case 'set':
      return ok({ folders: folders.length, phases: parsed.data.watchPhases.length });
    case 'invalid_folders':
      return err('VALIDATION', 'The database refused the folder list.');
    case 'invalid_phases':
      return err('VALIDATION', 'The database refused the phase list.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner or ops admin may change project defaults.');
    default:
      return err('INTERNAL', 'Could not save the project defaults.');
  }
}
