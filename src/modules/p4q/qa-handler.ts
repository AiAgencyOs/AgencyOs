import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { HandlerResult, UnlockJob } from '@/modules/projects/handlers';

import { callDoor } from './door';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * `project.prototype_build_ready` -> Prototype QA as a RECORDED RUN (P4-QAP-002..054).
 *
 * Replaces `handleReviewPrototypeBuild` as the subscriber: instead of three ad hoc arrays the database door `projects.p4q_run_prototype_qa` records the run, every named
 * check, the defects (in the same transaction as the verdict) and the verdict through the existing `record_prototype_qa_verdict`, and retests the defects this build
 * claims to fix. The checks are deterministic over the structured build, so no model is called. Checks the structured build cannot answer (rendered layout, visual
 * fidelity, role behaviour) are stored `not_verifiable` and are never counted as a pass.
 *
 * `blocked` is passed through when the caller knows an external dependency is missing (for example the test environment is unreachable): QA then records
 * BLOCKED_EXTERNAL with an owner and a resume condition instead of a verdict. This handler never approves, never verifies payment and never certifies Phase 6.
 */
export async function handleP4qReviewPrototypeBuild(
  admin: Admin,
  job: UnlockJob,
  blocked?: { reason: string; owner?: string; resumeCondition?: string },
): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const artifactId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;
  if (!artifactId) return { status: 'failed', permanent: true, detail: 'the event named no prototype artifact' };

  const result = await callDoor(admin, 'projects', 'p4q_run_prototype_qa', {
    p_artifact_id: artifactId,
    p_blocked_reason: blocked?.reason ?? null,
    p_blocked_owner: blocked?.owner ?? 'admin',
    p_resume_condition: blocked?.resumeCondition ?? null,
  });
  if (!result.ok) return { status: 'failed', permanent: false, detail: `the QA door did not answer: ${result.message}` };

  const outcome = result.row.outcome ?? 'no answer';
  const verdict = typeof result.row.verdict === 'string' ? result.row.verdict : null;
  switch (outcome) {
    case 'recorded':
      return { status: 'succeeded', outcome: verdict ?? 'recorded', detail: `Prototype QA run recorded: ${verdict}.` };
    case 'blocked':
      return { status: 'succeeded', outcome: verdict ?? 'blocked', detail: `Prototype QA could not reach a verdict (${verdict}); a blocker with an owner was recorded.` };
    case 'already_reviewed':
    case 'already_blocked':
      return { status: 'succeeded', outcome, detail: 'this build was already reviewed or is already blocked.' };
    case 'unknown_artifact':
      return { status: 'failed', permanent: true, detail: 'the prototype artifact no longer exists.' };
    case 'self_review':
    case 'forbidden':
      return { status: 'failed', permanent: true, detail: `the QA door refused: ${outcome}.` };
    default:
      return { status: 'failed', permanent: false, detail: `the QA door answered ${outcome}` };
  }
}
