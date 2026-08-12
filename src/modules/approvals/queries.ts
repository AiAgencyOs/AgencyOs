import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { ApprovalListItem, ApprovalPolicyRow } from './types';

/**
 * Reads for the approvals module. RLS-scoped, safe in Server Components.
 *
 * Every reader refuses rather than answering with a fallback value, for the
 * G-054 reason: an approval queue that renders empty because the database did
 * not answer is a page saying "nothing needs your attention" when it does not
 * know that. Of every read in this system that is the one where a calm lie
 * costs most — the whole point of the queue is that somebody is waiting.
 */

// One literal rather than concatenated parts: `'a' + 'b'` widens to `string`,
// and PostgREST's typed client parses the *literal* to work out the row shape.
// Concatenated, every read here returns GenericStringError instead of a row.
const LIST_SELECT =
  'id, subject_type, subject_id, state, audience, required_role, summary, amount_minor, sla_due_at, requested_by_type, requested_by_id, decided_at, decided_by, decision_note, evidence_ref, client_contact_id, correlation_id, created_at';

/**
 * What is waiting, soonest deadline first.
 *
 * Ordered by `sla_due_at` rather than by age because the deadline is what the
 * policy actually promised — a request raised later under a four-hour SLA is
 * more urgent than one raised this morning under a week's. Backed by
 * `approval_requests_queue_idx`.
 */
export async function listPendingApprovals(limit = 100): Promise<ApprovalListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('approvals')
    .from('approval_requests')
    .select(LIST_SELECT)
    .eq('state', 'pending')
    .order('sla_due_at', { ascending: true })
    .limit(limit);

  if (error) unreadable('listPendingApprovals', error);

  return data ?? [];
}

/** One request, whatever its state — the decision page and its history. */
export async function getApproval(requestId: string): Promise<ApprovalListItem | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('approvals')
    .from('approval_requests')
    .select(LIST_SELECT)
    .eq('id', requestId)
    .maybeSingle();

  // maybeSingle answers "no rows" as data: null with no error, so an error
  // here is always the database failing to answer rather than the request
  // being absent. The two are not the same thing — D6, one module along — and
  // conflating them is what made a failed read look like a missing invoice.
  if (error) unreadable('getApproval', error);

  return data ?? null;
}

/**
 * Every decision ever taken against one subject, newest first.
 *
 * The reason approvals are not a boolean on the subject's own row: a
 * deliverable rejected twice and approved on the third pass has three rows
 * here and one status there, and the three are the story.
 */
export async function listApprovalsForSubject(
  subjectType: string,
  subjectId: string,
): Promise<ApprovalListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('approvals')
    .from('approval_requests')
    .select(LIST_SELECT)
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .order('created_at', { ascending: false });

  if (error) unreadable('listApprovalsForSubject', error);

  return data ?? [];
}

/** The policy ladder, as the owner would read it: by subject, then threshold. */
export async function listApprovalPolicies(): Promise<ApprovalPolicyRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('approvals')
    .from('approval_policies')
    .select('id, subject_type, min_amount_minor, required_role, sla_hours, audience, active, note, updated_at')
    .eq('active', true)
    .order('subject_type', { ascending: true })
    .order('min_amount_minor', { ascending: true });

  if (error) unreadable('listApprovalPolicies', error);

  return data ?? [];
}
