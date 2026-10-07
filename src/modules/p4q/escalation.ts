import type { createAdminClient } from '@/lib/db/admin';

import { callDoor } from './door';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * W-P4 (P4-PM-escalation): when Task 2 cannot start because a requirement is missing, the refusal is no longer only a failed job. It opens the project's
 * one durable escalation row (`projects.p4q_open_escalation`, cause `blocked_requirement`), owned by an Admin, saying WHAT is missing, so a person sees it
 * where escalations are read (`/projects/<id>/p4q`) and resolves it with a decision.
 *
 * Idempotent in the database (one open row per project, cause and subject), best effort here: the refusal itself is what the caller reports, and an
 * escalation that could not be written is logged at error level and never changes that answer.
 */
export async function openBlockedRequirementEscalation(admin: Admin, projectId: string, missing: string): Promise<'opened' | 'already_open' | 'failed'> {
  try {
    const r = await callDoor(admin, 'projects', 'p4q_open_escalation', {
      p_project_id: projectId,
      p_cause: 'blocked_requirement',
      p_reason: missing,
      p_owner: 'admin',
      p_subject_type: null,
      p_subject_id: null,
      p_raised_by_agent: 'orchestrator',
      p_package: {},
    });
    const outcome = r.ok ? (r.row.outcome ?? 'no answer') : r.message;
    if (outcome === 'opened' || outcome === 'already_open') return outcome;
    console.error(JSON.stringify({ level: 'error', scope: 'p4q.escalation', projectId, detail: `the escalation door answered ${outcome}` }));
    return 'failed';
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'p4q.escalation', projectId, detail: e instanceof Error ? e.message : 'unknown' }));
    return 'failed';
  }
}
