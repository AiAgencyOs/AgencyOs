import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { callDoor } from './door';
import { evidenceRefusalMessage, type QaEvidenceKind } from './evidence-rules';

/**
 * P4-QAP-043: an uploaded file as the evidence of a prototype QA run.
 *
 * The order is the one every upload in this repository keeps, so nothing pretends to have landed: the checks that need no storage (size, kind of file, the
 * credentials guard on the name and on a small text file) and the storage probe come first (`storeAttachment`, area `evidence`, record = the QA run), the object goes
 * to the project-files bucket under `<organization>/evidence/<qa run id>/`, and only then `projects.p4s_attach_qa_evidence` records the row. The database door checks
 * the tenant, the run, the kind of file, the size and the path again, so a caller that skips this module cannot file what it would refuse. The bucket grants a person
 * no delete: an object whose row was refused stays unreferenced and is logged.
 */

export async function attachQaEvidence(input: {
  projectId: string;
  runId: string;
  kind: QaEvidenceKind;
  file: File;
  checkKey?: string | null;
  defectId?: string | null;
  note?: string | null;
}): Promise<Result<{ evidenceId: string }>> {
  const context = await requireInternal(`/projects/${input.projectId}/p4q`);
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to attach evidence.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { storeAttachment } = await import('@/modules/projects/attachment-store');
  const stored = await storeAttachment({ supabase, organizationId: context.organizationId, area: 'evidence', recordId: input.runId, file: input.file, noun: 'evidence file' });
  if (!stored.ok) return { ok: false, error: stored.error };

  const recorded = await callDoor(supabase, 'projects', 'p4s_attach_qa_evidence', {
    p_run_id: input.runId,
    p_storage_path: stored.data.path,
    p_file_name: stored.data.fileName,
    p_kind: input.kind,
    p_content_type: stored.data.contentType,
    p_size_bytes: stored.data.size,
    p_check_key: input.checkKey || null,
    p_defect_id: input.defectId || null,
    p_note: input.note || null,
  });
  const outcome = recorded.ok ? (recorded.row.outcome ?? 'no answer') : 'unreachable';
  const evidenceId = recorded.ok && typeof recorded.row.evidence_id === 'string' ? recorded.row.evidence_id : null;
  if (outcome !== 'attached' || !evidenceId) {
    console.error(JSON.stringify({ level: 'error', scope: 'attachQaEvidence', detail: `the database refused the record (${outcome}); the object stays unreferenced at ${stored.data.path}` }));
    return err('CONFLICT', evidenceRefusalMessage(outcome));
  }
  return ok({ evidenceId });
}
