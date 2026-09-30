import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { WATCH_PHASES, type WatchPhase } from './project-defaults-schema';
import type { StandardFolder } from './org-project-defaults-schema';
import { PROJECT_FILE_CATEGORIES } from './schema';

export type OrgProjectDefaults = { watchPhases: WatchPhase[]; folders: StandardFolder[]; updatedAt: string | null; configured: boolean };

/** The organisation's project defaults; nothing saved means "all four phases, no standard folders". */
export async function readOrgProjectDefaults(): Promise<OrgProjectDefaults> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('project_defaults').select('default_watch_phases, standard_folders, updated_at').maybeSingle();
  if (error) unreadable('readOrgProjectDefaults', error);
  if (!data) return { watchPhases: [...WATCH_PHASES], folders: [], updatedAt: null, configured: false };
  const folders = Array.isArray(data.standard_folders)
    ? (data.standard_folders as { category?: string; path?: string }[]).filter(
        (f): f is StandardFolder => typeof f?.path === 'string' && (PROJECT_FILE_CATEGORIES as readonly string[]).includes(f.category ?? ''),
      )
    : [];
  return { watchPhases: ((data.default_watch_phases ?? []) as string[]).filter((p): p is WatchPhase => (WATCH_PHASES as readonly string[]).includes(p)), folders, updatedAt: data.updated_at, configured: true };
}
