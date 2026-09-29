import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The design review queue across every project — SCR-036.
 *
 * Phase 3's gate order (Master §16; 20260919120000) is three columns on
 * `projects.theme_options`, and each project's Themes tab shows them for
 * that project. This is the cross-project view: which options are sitting
 * at which gate, so a reviewer, an Admin or an account owner does not open
 * every project to find the one waiting on them.
 *
 *   · awaiting internal — `internal_review_status = 'in_review'`, the
 *     assigned reviewer's queue;
 *   · awaiting Admin — internal passed, `admin_status = 'in_review'`;
 *   · awaiting the client — `client_status = 'shared'`, the client has been
 *     shown it and has not answered (a `client_design_share` was recorded
 *     and no decision has moved the status on).
 *
 * Read as stored. The database refuses the out-of-order move; this only
 * shows where each option stands.
 */

export type DesignQueueRow = {
  themeOptionId: string;
  projectId: string;
  projectName: string;
  phaseThreeId: string;
  name: string;
  optionIndex: number;
  version: number;
  internalReviewStatus: string;
  adminStatus: string;
  clientStatus: string;
  waitingOn: 'internal' | 'admin' | 'client';
  updatedAt: string;
  reviewerUserId: string | null;
};

export type DesignReviewQueue = {
  awaitingInternal: number;
  awaitingAdmin: number;
  awaitingClient: number;
  rows: DesignQueueRow[];
};

function waitingOn(t: { internal_review_status: string; admin_status: string; client_status: string }): DesignQueueRow['waitingOn'] | null {
  if (t.client_status === 'shared') return 'client';
  if (t.admin_status === 'in_review') return 'admin';
  if (t.internal_review_status === 'in_review') return 'internal';
  return null;
}

export async function readDesignReviewQueue(): Promise<DesignReviewQueue> {
  const supabase = await createClient();

  const { data: themes, error: themesError } = await supabase
    .schema('projects')
    .from('theme_options')
    .select('id, project_id, phase_three_id, name, option_index, version, internal_review_status, admin_status, client_status, updated_at')
    .or('internal_review_status.eq.in_review,admin_status.eq.in_review,client_status.eq.shared')
    .order('updated_at', { ascending: true });
  if (themesError) unreadable('readDesignReviewQueue.themes', themesError);

  const waiting = (themes ?? [])
    .map((t) => ({ t, on: waitingOn(t) }))
    .filter((x): x is { t: (typeof x)['t']; on: DesignQueueRow['waitingOn'] } => x.on !== null);

  const projectIds = [...new Set(waiting.map((w) => w.t.project_id))];
  const phaseIds = [...new Set(waiting.map((w) => w.t.phase_three_id))];
  const projectName = new Map<string, string>();
  const reviewerByPhase = new Map<string, string | null>();
  if (projectIds.length > 0) {
    const [projects, phases] = await Promise.all([
      supabase.schema('projects').from('projects').select('id, name').in('id', projectIds).is('deleted_at', null),
      supabase.schema('projects').from('phase_three').select('id, reviewer_user_id').in('id', phaseIds),
    ]);
    if (projects.error) unreadable('readDesignReviewQueue.projects', projects.error);
    if (phases.error) unreadable('readDesignReviewQueue.phases', phases.error);
    for (const p of projects.data ?? []) projectName.set(p.id, p.name);
    for (const ph of phases.data ?? []) reviewerByPhase.set(ph.id, ph.reviewer_user_id);
  }

  const rows: DesignQueueRow[] = waiting
    .filter((w) => projectName.has(w.t.project_id))
    .map(({ t, on }) => ({
      themeOptionId: t.id,
      projectId: t.project_id,
      projectName: projectName.get(t.project_id) ?? 'Unknown project',
      phaseThreeId: t.phase_three_id,
      name: t.name,
      optionIndex: t.option_index,
      version: t.version,
      internalReviewStatus: t.internal_review_status,
      adminStatus: t.admin_status,
      clientStatus: t.client_status,
      waitingOn: on,
      updatedAt: t.updated_at,
      reviewerUserId: reviewerByPhase.get(t.phase_three_id) ?? null,
    }));

  return {
    awaitingInternal: rows.filter((r) => r.waitingOn === 'internal').length,
    awaitingAdmin: rows.filter((r) => r.waitingOn === 'admin').length,
    awaitingClient: rows.filter((r) => r.waitingOn === 'client').length,
    rows,
  };
}
