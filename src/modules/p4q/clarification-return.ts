import type { createAdminClient } from '@/lib/db/admin';
import { HANDLER_JOB_KIND } from '@/lib/events/catalog';
import type { HandlerResult, UnlockJob } from '@/modules/projects/handlers';

import { callDoor } from './door';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * W-P3 (P4-PM-clarification): `project.p4q_clarification_answered` -> the answer goes back to the agent that asked.
 *
 * An agent that cannot proceed raises a clarification through `projects.p4q_raise_clarification` (the PM relays it to the client one at a time, in the
 * client's wording). When the clarification is answered the database emits this event naming the agent in `raisedBy`. This handler re-reads the clarification
 * ROW (the event is a claim: it names a row, and the row says who asked and whether it was really answered) and then puts the asking agent's stopped work
 * item back on the queue.
 *
 * "The asking agent's work item" is a job of a kind that agent owns (the handler names in the event catalog are prefixed with the agent key), in the same
 * organization, that gave up (`dead`) and that concerns this project: its subject is the clarification's UI version, or its event payload names the project.
 * Each is requeued through `core.requeue_job_with_reason` with the reason recorded. Nothing else changes: the answer does not alter scope, does not approve
 * anything and does not decide for a person; a job that is not dead is already going to run and is left alone.
 */
const AGENTS = new Set(['ui_designer', 'quality_assurance', 'ui_prototype', 'project_manager']);

export function jobKindsOwnedBy(agentKey: string): string[] {
  return Object.entries(HANDLER_JOB_KIND)
    .filter(([handler]) => handler.startsWith(`${agentKey}:`))
    .map(([, kind]) => kind);
}

export async function handleP4qClarificationAnswered(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const clarificationId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;
  if (!clarificationId) return { status: 'failed', permanent: true, detail: 'the event named no clarification' };

  const { data: row, error } = await admin
    .schema('projects')
    .from('clarification_requests')
    .select('id, project_id, ui_version_id, raised_by, status')
    .eq('id', clarificationId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (error) return { status: 'failed', permanent: false, detail: `the clarification could not be read: ${error.message}` };
  if (!row) return { status: 'succeeded', outcome: 'gone', detail: 'the clarification no longer exists' };
  if (row.status !== 'answered') return { status: 'succeeded', outcome: 'not_mine', detail: `the clarification is ${row.status}, not answered` };
  const agent = String(row.raised_by ?? '');
  if (!AGENTS.has(agent)) return { status: 'succeeded', outcome: 'not_mine', detail: `${agent || 'nobody'} is not a Phase 4 agent` };

  const kinds = jobKindsOwnedBy(agent);
  if (kinds.length === 0) return { status: 'succeeded', outcome: 'nothing_waiting', detail: `${agent} owns no queued work kinds` };

  const { data: dead, error: deadError } = await admin
    .schema('core')
    .from('jobs')
    .select('id, kind, payload')
    .eq('organization_id', job.organization_id)
    .eq('status', 'dead')
    .in('kind', kinds)
    .order('updated_at', { ascending: false })
    .limit(50);
  if (deadError) return { status: 'failed', permanent: false, detail: `the stopped work could not be listed: ${deadError.message}` };

  const mine = (dead ?? []).filter((j) => {
    const payload = (j.payload ?? {}) as { subjectId?: unknown; event?: { projectId?: unknown; phaseFourId?: unknown } };
    if (row.ui_version_id && payload.subjectId === row.ui_version_id) return true;
    return payload.event?.projectId === row.project_id;
  });
  if (mine.length === 0) return { status: 'succeeded', outcome: 'nothing_waiting', detail: `${agent} has no stopped work for this project; the answer is on the clarification` };

  let requeued = 0;
  for (const j of mine) {
    const r = await callDoor(admin, 'core', 'requeue_job_with_reason', { p_job_id: j.id, p_reason: `The clarification ${clarificationId} was answered; ${agent} may continue.` });
    if (r.ok && r.row.outcome === 'requeued') requeued += 1;
  }
  return { status: 'succeeded', outcome: requeued > 0 ? 'returned' : 'nothing_requeued', detail: `${requeued} of ${mine.length} stopped ${agent} job(s) put back on the queue` };
}
