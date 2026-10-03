import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { recordScopeApprovalSchema, type RecordScopeApprovalInput } from './scope-approval-schema';

/**
 * SCR-030 — record who approved a frozen baseline and where the evidence
 * is. `milestone.write` (the scope doors' capability);
 * `projects.record_scope_approval_evidence` checks `core.can_manage_delivery()`
 * again, refuses a draft, and audits `scope_version.approval_recorded`.
 */
export async function recordScopeApproval(input: RecordScopeApprovalInput): Promise<Result<{ recorded: true }>> {
  const parsed = recordScopeApprovalSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid approval.');

  const context = await requireInternal();
  if (!can(context, 'milestone.write')) return err('FORBIDDEN', 'You do not have permission to record scope approval.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_scope_approval_evidence', {
    p_scope_version_id: parsed.data.scopeVersionId,
    p_approved_by: parsed.data.approvedBy,
    ...(parsed.data.evidenceUrl ? { p_evidence_url: parsed.data.evidenceUrl } : {}),
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordScopeApproval', detail: error.message }));
    return err('INTERNAL', 'Could not record the approval.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'recorded':
      return ok({ recorded: true });
    case 'not_frozen':
      return err('CONFLICT', 'This version is still a draft — a draft has nothing to approve. Freeze it first.');
    case 'no_approver':
      return err('VALIDATION', 'Name who approved it.');
    case 'not_found':
      return err('NOT_FOUND', 'That scope version is not visible to you.');
    default:
      return err('FORBIDDEN', 'You do not have permission to record approval on this baseline.');
  }
}
