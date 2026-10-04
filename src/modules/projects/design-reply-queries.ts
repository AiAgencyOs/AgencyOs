import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What the project manager read from the client's replies to the design options - Phase 3 PM §4.5.
 * Newest first. Read only; a failed read refuses (G-054), so an empty inbox is never a hidden error.
 */

export type DesignReplyRow = {
  id: string;
  intent: string;
  action: string;
  status: string;
  source: string;
  clientWords: string;
  confidence: number;
  reasoning: string | null;
  themeName: string | null;
  colorName: string | null;
  referenceUrl: string | null;
  referenceNote: string | null;
  decisionId: string | null;
  revisionId: string | null;
  resolutionNote: string | null;
  createdAt: string;
};

export async function readDesignReplies(phaseThreeId: string, limit = 25): Promise<DesignReplyRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('design_reply_proposals')
    .select('id, intent, action, status, source, client_words, confidence, reasoning, reference_url, reference_note, decision_id, revision_id, resolution_note, created_at, selected_theme_option_id, selected_color_option_id')
    .eq('phase_three_id', phaseThreeId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('readDesignReplies', error);
  const rows = data ?? [];

  const themeIds = [...new Set(rows.map((r) => r.selected_theme_option_id).filter((v): v is string => Boolean(v)))];
  const colorIds = [...new Set(rows.map((r) => r.selected_color_option_id).filter((v): v is string => Boolean(v)))];
  const [themes, colors] = await Promise.all([
    themeIds.length > 0 ? supabase.schema('projects').from('theme_options').select('id, name').in('id', themeIds) : Promise.resolve({ data: [], error: null }),
    colorIds.length > 0 ? supabase.schema('projects').from('color_options').select('id, palette_name').in('id', colorIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (themes.error) unreadable('readDesignReplies.themes', themes.error);
  if (colors.error) unreadable('readDesignReplies.colors', colors.error);
  const themeName = new Map((themes.data ?? []).map((t) => [t.id, t.name]));
  const colorName = new Map((colors.data ?? []).map((c) => [c.id, c.palette_name]));

  return rows.map((r) => ({
    id: r.id,
    intent: r.intent,
    action: r.action,
    status: r.status,
    source: r.source,
    clientWords: r.client_words,
    confidence: Number(r.confidence),
    reasoning: r.reasoning,
    themeName: r.selected_theme_option_id ? themeName.get(r.selected_theme_option_id) ?? null : null,
    colorName: r.selected_color_option_id ? colorName.get(r.selected_color_option_id) ?? null : null,
    referenceUrl: r.reference_url,
    referenceNote: r.reference_note,
    decisionId: r.decision_id,
    revisionId: r.revision_id,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
  }));
}
