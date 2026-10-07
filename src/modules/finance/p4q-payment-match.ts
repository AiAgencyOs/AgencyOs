import type { createAdminClient } from '@/lib/db/admin';
import { looseSchema } from '@/lib/p13/loose-client';
import type { HandlerResult, UnlockJob } from '@/modules/projects/handlers';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * W-F4 (P4-FIN payment match): `payment.submitted` -> a deterministic, persisted match of the claim against its invoice and the accounts that were on it
 * (`finance.p4q_match_payment_submission`), with a recommendation (MATCH / REVIEW / REJECT / EXCEPTION) and its reasons, ready for the person who verifies.
 *
 * It is ADVICE. It verifies nothing, rejects nothing, marks nothing paid and tells the client nothing; `finance.verify_payment` stays a person's act and the
 * packet the verifier reads says so. The claim is re-read here for the JOB's organization (the event names a row; the row decides), and a claim that is
 * no longer awaiting a decision is left alone.
 */
export async function handleMatchPaymentSubmission(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const submissionId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;
  if (!submissionId) return { status: 'failed', permanent: true, detail: 'the event named no payment submission' };

  const { data: submission, error } = await admin
    .schema('finance')
    .from('payment_submissions')
    .select('id, status')
    .eq('id', submissionId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (error) return { status: 'failed', permanent: false, detail: `the payment could not be read: ${error.message}` };
  if (!submission) return { status: 'succeeded', outcome: 'gone', detail: 'the payment submission no longer exists' };
  if (submission.status !== 'pending_verification') {
    return { status: 'succeeded', outcome: 'not_mine', detail: `the claim is ${submission.status}; there is nothing left to advise on` };
  }

  const { data, error: doorError } = await looseSchema(admin as never, 'finance').rpc('p4q_match_payment_submission', { p_submission_id: submissionId });
  if (doorError) return { status: 'failed', permanent: false, detail: `the match door did not answer: ${doorError.message}` };
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; match_class?: string; recommendation?: string } | null | undefined;
  const outcome = row?.outcome ?? 'no answer';
  if (outcome === 'prepared' || outcome === 'unchanged') {
    return { status: 'succeeded', outcome, detail: `Advice prepared: ${row?.recommendation} (${row?.match_class}). Nothing was verified.` };
  }
  return { status: 'failed', permanent: outcome === 'not_found' || outcome === 'forbidden', detail: `the match door answered ${outcome}` };
}
