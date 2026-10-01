import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type DeliverableDetails = {
  deliverableId: string;
  platform: string | null;
  adminStatus: 'pending' | 'approved' | 'changes_required';
  adminDecidedAt: string | null;
  adminNote: string | null;
  qaStatus: 'not_reviewed' | 'passed' | 'changes_required';
  qaNote: string | null;
  qaEvidenceUrl: string | null;
  qaDecidedAt: string | null;
  commitRef: string | null;
  buildNumber: string | null;
  rollbackTargetId: string | null;
  rollbackNote: string | null;
};

/** The details of every prototype and build of a project, by deliverable id. */
export async function readDeliverableDetails(projectId: string): Promise<Map<string, DeliverableDetails>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('deliverable_details')
    .select('deliverable_id, platform, admin_status, admin_decided_at, admin_note, commit_ref, build_number, rollback_target_id, rollback_note, qa_status, qa_note, qa_evidence_url, qa_decided_at')
    .eq('project_id', projectId);
  if (error) unreadable('readDeliverableDetails', error);
  return new Map(
    (data ?? []).map((d) => [
      d.deliverable_id,
      {
        deliverableId: d.deliverable_id,
        platform: d.platform,
        adminStatus: (d.admin_status === 'approved' || d.admin_status === 'changes_required' ? d.admin_status : 'pending') as DeliverableDetails['adminStatus'],
        adminDecidedAt: d.admin_decided_at,
        adminNote: d.admin_note,
        qaStatus: (d.qa_status === 'passed' || d.qa_status === 'changes_required' ? d.qa_status : 'not_reviewed') as DeliverableDetails['qaStatus'],
        qaNote: d.qa_note,
        qaEvidenceUrl: d.qa_evidence_url,
        qaDecidedAt: d.qa_decided_at,
        commitRef: d.commit_ref,
        buildNumber: d.build_number,
        rollbackTargetId: d.rollback_target_id,
        rollbackNote: d.rollback_note,
      },
    ]),
  );
}

export type PrototypeSendGate = { qaPassed: boolean; adminApproved: boolean; qaSource: string };

/** Where a prototype stands against the normal path to the client — the database's own answer, not a copy of its rule. */
export async function readPrototypeSendGate(deliverableId: string): Promise<PrototypeSendGate> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('prototype_send_gate', { p_deliverable_id: deliverableId });
  if (error) unreadable('readPrototypeSendGate', error);
  const row = (Array.isArray(data) ? data[0] : data) as { qa_passed?: boolean; admin_approved?: boolean; qa_source?: string } | undefined;
  return { qaPassed: Boolean(row?.qa_passed), adminApproved: Boolean(row?.admin_approved), qaSource: row?.qa_source ?? 'no QA evidence' };
}
