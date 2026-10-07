import type { createAdminClient } from '@/lib/db/admin';
import type { HandlerResult, UnlockJob } from '@/modules/projects/handlers';

import { callDoor } from './door';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * W-Q2 (P4-QAP-019 / 046): `project.p4q_prototype_fix_ready` -> the defect reads QA_RETEST.
 *
 * A build that declares it fixes a defect puts the defect at FIX_READY (a claim). This subscriber records that QA now owes a retest of that exact fix build, through
 * `projects.p4s_request_defect_retest`. It is a state on the record and nothing else: it runs no model, verifies nothing (a retest pass still leaves the defect for a
 * named person to verify), and approves nothing. The event is a claim: the door re-reads the defect row and refuses a defect with no claimed fix, a deferred one, or
 * one that is already retested.
 */
export async function handleRequestDefectRetest(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const defectId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;
  if (!defectId) return { status: 'failed', permanent: true, detail: 'the event named no defect' };

  const result = await callDoor(admin, 'projects', 'p4s_request_defect_retest', { p_defect_id: defectId });
  if (!result.ok) return { status: 'failed', permanent: false, detail: `the retest door did not answer: ${result.message}` };

  const outcome = result.row.outcome ?? 'no answer';
  switch (outcome) {
    case 'requested':
      return { status: 'succeeded', outcome, detail: 'QA now owes a retest of the exact fix build.' };
    case 'already_requested':
    case 'already_retested':
    case 'deferred':
    case 'no_fix_build':
    case 'unknown_defect':
      return { status: 'succeeded', outcome: 'not_mine', detail: `nothing to request: ${outcome}.` };
    case 'forbidden':
    case 'no_actor':
      return { status: 'failed', permanent: true, detail: `the retest door refused: ${outcome}.` };
    default:
      return { status: 'failed', permanent: false, detail: `the retest door answered ${outcome}` };
  }
}
