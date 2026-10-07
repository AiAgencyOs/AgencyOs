import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { looseSchema } from '@/lib/p13/loose-client';
import { err, ok, unreadable, type Result } from '@/lib/result';

export type ApprovalAnnotation = {
  risk_level: 'low' | 'medium' | 'high' | 'critical' | 'unrated';
  risk_source: 'policy' | 'admin' | 'no_policy';
  policy_version_id: string | null;
  executed_at: string | null;
  verified_at: string | null;
};

/** P1-API-024: the risk, the policy version and the executed / verified stamps of one approval request (RLS-scoped). */
export async function readApprovalAnnotation(requestId: string): Promise<ApprovalAnnotation | null> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'approvals')
    .from('p13_approval_annotations')
    .select('risk_level, risk_source, policy_version_id, executed_at, verified_at')
    .eq('approval_request_id', requestId)
    .maybeSingle();
  if (error) unreadable('readApprovalAnnotation', error);
  return (data as ApprovalAnnotation | null) ?? null;
}

const REFUSAL: Record<string, string> = {
  not_approved: 'Only an approved request can be marked executed.',
  not_executed: 'Nothing can be verified before it has been executed.',
  already_executed: 'Already marked executed.',
  already_verified: 'Already verified.',
  not_authorized: 'Only an owner or ops admin may do this.',
  not_found: 'That approval request does not exist.',
};

async function call(fn: 'p13_mark_approval_executed' | 'p13_mark_approval_verified', requestId: string, note: string): Promise<Result<null>> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to record this.');
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'approvals').rpc(fn, { p_request_id: requestId, p_note: note || null });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: fn, detail: error.message }));
    return err('INTERNAL', 'Could not record that.');
  }
  return data === 'executed' || data === 'verified' ? ok(null) : err('VALIDATION', REFUSAL[String(data)] ?? 'The database refused.');
}

export const markApprovalExecuted = (requestId: string, note: string) => call('p13_mark_approval_executed', requestId, note);
export const markApprovalVerified = (requestId: string, note: string) => call('p13_mark_approval_verified', requestId, note);
