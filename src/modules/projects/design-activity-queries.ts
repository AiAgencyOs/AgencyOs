import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-032 — the design activity feed: every audit row whose subject is a
 * design artefact of this project, read through
 * `projects.read_design_activity` (migration 20261001130000) so a delivery
 * lead sees their own project's history although audit.audit_log itself is
 * owner/ops_admin territory. Read only; a failed read refuses.
 */

export type DesignActivityEntry = {
  id: number;
  action: string;
  subjectType: string;
  subjectId: string | null;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  after: Record<string, unknown> | null;
  createdAt: string;
};

export async function readDesignActivity(projectId: string, limit = 30): Promise<DesignActivityEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('read_design_activity', { p_project_id: projectId, p_limit: limit });
  if (error) unreadable('readDesignActivity', error);
  type Row = {
    id: number;
    action: string;
    subject_type: string;
    subject_id: string | null;
    actor_type: string;
    actor_id: string | null;
    actor_name: string | null;
    after: unknown;
    created_at: string;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    action: r.action,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    after: (r.after ?? null) as Record<string, unknown> | null,
    createdAt: r.created_at,
  }));
}

/** The sentence for an audit action, in words a person on the design tab uses. */
export function describeDesignAction(action: string): string {
  const known: Record<string, string> = {
    'project.theme_options_generated': 'Theme direction generated',
    'project.theme_direction_recorded': 'Theme direction recorded',
    'project.color_options_generated': 'Colour palette generated',
    'project.color_variant_recorded': 'Colour variant recorded',
    'project.design_asset_generated': 'Reference image generated',
    'project.design_asset_uploaded': 'Design asset uploaded',
    'project.design_asset_replaced': 'Design asset replaced with a new version',
    'project.design_asset_approved': 'Design asset approved',
    'project.screen_added': 'Screen added',
    'project.screens_merged': 'Screens merged',
    'project.screen_split': 'Screen split',
    'project.screen_design_state_set': 'Screen design state set',
    'project.screen_states_set': 'Screen states edited',
    'project.screen_submitted_for_qa': 'Screen submitted for QA',
    'project.screen_list_drafted': 'Screen baseline drafted',
    'project.screen_list_finalized': 'Screen baseline finalized',
    'phase_three.started': 'Phase 3 started',
    'phase_three.locked': 'Direction locked for Phase 4',
    'theme_option.figma_linked': 'Figma reference linked',
    'project.ui_version_drafted': 'UI version drafted',
    'project.ui_version_admin_reviewed': 'UI version reviewed by admin',
    'project.ui_version_shared_to_client': 'UI version shared with the client',
    'project.ui_version_client_decided': 'Client decided on a UI version',
    'project.ui_version_qa_reviewed': 'UI version reviewed by QA',
    'project.ui_version_locked': 'UI version locked',
    'project.prototype_build_ready': 'Prototype build ready',
    'project.prototype_qa_reviewed': 'Prototype reviewed by QA',
    'project.prototype_platform_set': 'Prototype platform set',
    'project.prototype_submitted_to_qa': 'Prototype submitted to QA',
  };
  return known[action] ?? action.replace(/^[a-z_]+\./, '').replace(/_/g, ' ');
}
