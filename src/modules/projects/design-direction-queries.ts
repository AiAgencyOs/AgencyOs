import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-033 — which theme directions and colour variants a person recorded
 * and which the agent generated (`source`, migration 20261001130000), plus
 * the phase's ceiling, so the Color studio can count and offer the next
 * option index honestly. Read only; a failed read refuses.
 */

export type DirectionSources = {
  themeSource: Map<string, 'generated' | 'recorded'>;
  colorSource: Map<string, 'generated' | 'recorded'>;
  /** theme_option_limit of the phase — the 2–3 ceiling. */
  themeLimit: number | null;
  /** Option indexes already taken on the newest design context, per theme (colours) and for the phase (themes). */
  takenThemeIndexes: number[];
  takenColorIndexes: Map<string, number[]>;
};

export async function readDirectionSources(projectId: string): Promise<DirectionSources> {
  const supabase = await createClient();
  const [themes, phase] = await Promise.all([
    supabase.schema('projects').from('theme_options').select('id, option_index, source, source_context_version').eq('project_id', projectId),
    supabase.schema('projects').from('phase_three').select('theme_option_limit').eq('project_id', projectId).maybeSingle(),
  ]);
  if (themes.error) unreadable('readDirectionSources.themes', themes.error);
  if (phase.error) unreadable('readDirectionSources.phase', phase.error);

  type ThemeRow = { id: string; option_index: number; source: string; source_context_version: string };
  const themeRows = (themes.data ?? []) as ThemeRow[];
  const themeSource = new Map<string, 'generated' | 'recorded'>(themeRows.map((t) => [t.id, t.source === 'recorded' ? 'recorded' : 'generated']));

  const colorSource = new Map<string, 'generated' | 'recorded'>();
  const takenColorIndexes = new Map<string, number[]>();
  if (themeRows.length > 0) {
    const { data: colors, error } = await supabase
      .schema('projects')
      .from('color_options')
      .select('id, theme_option_id, option_index, source')
      .in('theme_option_id', themeRows.map((t) => t.id));
    if (error) unreadable('readDirectionSources.colors', error);
    for (const c of (colors ?? []) as { id: string; theme_option_id: string; option_index: number; source: string }[]) {
      colorSource.set(c.id, c.source === 'recorded' ? 'recorded' : 'generated');
      takenColorIndexes.set(c.theme_option_id, [...(takenColorIndexes.get(c.theme_option_id) ?? []), c.option_index]);
    }
  }

  return {
    themeSource,
    colorSource,
    themeLimit: (phase.data as { theme_option_limit?: number } | null)?.theme_option_limit ?? null,
    takenThemeIndexes: themeRows.map((t) => t.option_index),
    takenColorIndexes,
  };
}
