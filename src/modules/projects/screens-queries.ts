import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { Tables } from '@/lib/db/types';

/**
 * Reads for the Screen Inventory (SCR-034) — `projects.screens`, every
 * column, as stored. Pure and RLS-scoped like the rest of the module's
 * readers: the policy decides which rows exist, and nothing here writes.
 */

export type ProjectScreen = Tables<{ schema: 'projects' }, 'screens'>;

const SCREEN_SELECT =
  'id, project_id, organization_id, deliverable_id, name, screen_key, status, user_role, purpose, entry_point, exit_action, actions, required_data, required_sections, dependencies, validation, permission_behaviour, responsive_behaviour, accessibility_notes, has_empty_state, has_error_state, has_loading_state, has_success_state, baseline_version, figma_url, design_state, qa_status, superseded_by, device_targets, components, responsive_coverage, created_at, created_by, updated_at';

/** Every screen recorded for a project, in `screen_key` order. */
export async function listProjectScreens(projectId: string): Promise<ProjectScreen[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('screens')
    .select(SCREEN_SELECT)
    .eq('project_id', projectId)
    .order('screen_key', { ascending: true });

  // G-054: an empty inventory on a failed read would say nothing has been
  // designed, which is a statement about somebody's work, not the database.
  if (error) unreadable('listProjectScreens', error);
  return data ?? [];
}

/** One screen, scoped to its project so a foreign id reads as absent. */
export async function getProjectScreen(projectId: string, screenId: string): Promise<ProjectScreen | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('screens')
    .select(SCREEN_SELECT)
    .eq('project_id', projectId)
    .eq('id', screenId)
    .maybeSingle();

  if (error) unreadable('getProjectScreen', error);
  return data;
}

/**
 * `required_sections` and `dependencies` are free text as stored. Where a
 * writer separated items by newline, semicolon or comma, this shows them as
 * a list; otherwise the whole value is one item. No item is invented.
 */
export function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n|;|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
