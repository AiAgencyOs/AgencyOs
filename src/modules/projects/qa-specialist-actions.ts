'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import { QA_SPECIALIST_AGENTS, SPECIALIST_OUTCOME_WORDS } from './qa-specialist-findings';

/**
 * Admin actions for the nine Phase 6 QA specialists.
 *
 * "Ask the QA specialist" is TWO steps: the person calls the database door `qa.request_specialist_run` AS THEMSELVES (which checks delivery rights, the
 * job's organization and state, and records WHO asked - the person who may not later accept the answer), and only then is a job queued for the agent
 * the DOOR named (never one the form named). The agent only PROPOSES (app/api/jobs/run/qa-specialist-workflows.ts). Accepting or rejecting a proposal
 * calls the database doors as the same person; the result door `qa.record_case_result` runs inside acceptance under that person's identity, and
 * every refusal is shown as written. Nothing here records a result directly.
 */

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function gate(): Promise<{ organizationId: string } | FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write') || !context.organizationId) return { status: 'error', message: 'You do not have permission to change this project.' };
  return { organizationId: context.organizationId };
}

const firstRow = (data: unknown): Record<string, unknown> | null => ((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null) ?? null;

/** Ask the specialist for a QA job (or, for release readiness, a release candidate). */
export async function requestQaSpecialistAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = text(formData, 'projectId');
  // the form's one select posts "jobId:<uuid>" or "candidateId:<uuid>"
  const [subjectKind, subjectId = ''] = text(formData, 'subject').split(':');
  const jobId = subjectKind === 'jobId' ? subjectId : '';
  const candidateId = subjectKind === 'candidateId' ? subjectId : '';
  if (!UUID.test(projectId) || (jobId && !UUID.test(jobId)) || (candidateId && !UUID.test(candidateId)) || (jobId ? 1 : 0) + (candidateId ? 1 : 0) !== 1) {
    return { status: 'error', message: 'Choose one QA job or one release candidate.' };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('request_specialist_run' as never, { p_job_id: jobId || null, p_candidate_id: candidateId || null } as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was requested.' };
  const row = firstRow(data);
  const outcome = String(row?.outcome ?? 'no answer');
  if (outcome !== 'requested') return { status: 'error', message: SPECIALIST_OUTCOME_WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };

  // the agent is the one the DOOR recorded; it must be one of the nine
  const agent = String(row?.agent_key ?? '');
  const requestId = String(row?.request_id ?? '');
  if (!(QA_SPECIALIST_AGENTS as readonly string[]).includes(agent) || !UUID.test(requestId)) return { status: 'error', message: 'The database named an unexpected specialist; nothing was queued.' };
  const { error: insertError } = await createAdminClient().schema('core').from('jobs').insert({
    organization_id: g.organizationId,
    kind: `qa.${agent}.propose`,
    payload: { requestId, projectId },
    dedupe_key: `qa.${agent}.propose:${requestId}`,
  });
  // a unique violation is the same request twice: it is already queued
  if (insertError && insertError.code !== '23505') return { status: 'error', message: 'The request was recorded but could not be queued.' };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Asked the QA specialist. Its proposals appear below; none of them is a result until a different person accepts it.' };
}

/** Accept or reject one proposal. The database decides independence, the commit and the evidence rule; its answer is reported as written. */
export async function decideQaFindingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const g = await gate();
  if ('status' in g) return g;
  const projectId = text(formData, 'projectId');
  const findingId = text(formData, 'findingId');
  const decision = text(formData, 'decision');
  const note = text(formData, 'note');
  if (!UUID.test(projectId) || !UUID.test(findingId) || (decision !== 'accept' && decision !== 'reject')) return { status: 'error', message: 'That proposal was not found.' };
  const supabase = await createClient();
  const { data, error } = decision === 'accept'
    ? await supabase.schema('qa').rpc('accept_specialist_finding' as never, { p_finding_id: findingId, p_note: note || null } as never)
    : await supabase.schema('qa').rpc('reject_specialist_finding' as never, { p_finding_id: findingId, p_note: note } as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was decided.' };
  const row = firstRow(data);
  const outcome = String(row?.outcome ?? 'no answer');
  if (outcome !== 'accepted' && outcome !== 'rejected') {
    const why = row?.case_outcome ? ` (${String(row.case_outcome).replace(/_/g, ' ')})` : '';
    return { status: 'error', message: `${SPECIALIST_OUTCOME_WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`}${why}` };
  }
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: outcome === 'accepted' ? `Accepted${row?.case_outcome === 'recorded' ? ' and recorded as the case result under your name' : ''}.` : SPECIALIST_OUTCOME_WORDS.rejected! };
}
