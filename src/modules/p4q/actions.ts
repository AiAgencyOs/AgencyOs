'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { createClient } from '@/lib/db/server';

import { callDoor } from './door';

const ids = z.object({ projectId: z.uuid() });

function back(projectId: string, notice: string): never {
  revalidatePath(`/projects/${projectId}/p4q`);
  redirect(`/projects/${projectId}/p4q?notice=${encodeURIComponent(notice)}`);
}

/** A person resolves a QA blocker (BLOCKED_EXTERNAL / INVALID_INTAKE). Resolving does not pass the build; it lets QA run again. */
export async function resolveQaBlockerAction(formData: FormData): Promise<void> {
  const parsed = ids.extend({ blockerId: z.uuid(), note: z.string().trim().min(5).max(1000) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect('/projects');
  const r = await callDoor(await createClient(), 'projects', 'p4q_resolve_qa_blocker', { p_blocker_id: parsed.data.blockerId, p_note: parsed.data.note });
  back(parsed.data.projectId, r.ok ? `QA blocker: ${r.row.outcome}` : 'QA blocker: could not be saved');
}

/** A person (not the one who built the fix) verifies a defect whose exact fix build passed the retest. */
export async function verifyRetestedDefectAction(formData: FormData): Promise<void> {
  const parsed = ids.extend({ defectId: z.uuid() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect('/projects');
  const r = await callDoor(await createClient(), 'projects', 'p4q_verify_retested_defect', { p_defect_id: parsed.data.defectId });
  back(parsed.data.projectId, r.ok ? `Defect: ${r.row.outcome}` : 'Defect: could not be saved');
}

/** A person resolves a project escalation with a decision and a note. */
export async function resolveEscalationAction(formData: FormData): Promise<void> {
  const parsed = ids
    .extend({ escalationId: z.uuid(), decision: z.enum(['continue', 'change_request', 'stop', 'reassign', 'fix_and_retry', 'dismissed']), note: z.string().trim().min(5).max(1000) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect('/projects');
  const r = await callDoor(await createClient(), 'projects', 'p4q_resolve_escalation', { p_escalation_id: parsed.data.escalationId, p_decision: parsed.data.decision, p_note: parsed.data.note });
  back(parsed.data.projectId, r.ok ? `Escalation: ${r.row.outcome}` : 'Escalation: could not be saved');
}

/** Record that the exact approved UI version or QA-passed build was shown to the client (after the act, with the channel). */
export async function recordClientReviewShareAction(formData: FormData): Promise<void> {
  const parsed = ids
    .extend({ kind: z.enum(['ui_version', 'prototype_build']), targetId: z.uuid(), channel: z.enum(['whatsapp', 'email', 'portal', 'internal_group', 'manual']) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect('/projects');
  const r = await callDoor(await createClient(), 'projects', 'p4q_record_client_review_share', { p_kind: parsed.data.kind, p_target_id: parsed.data.targetId, p_channel: parsed.data.channel });
  back(parsed.data.projectId, r.ok ? `Share: ${r.row.outcome}` : 'Share: could not be saved');
}

/** Record what is known about a share's delivery. Sent and delivered need evidence; an uncertain send is recorded as unknown. */
export async function markShareDeliveryAction(formData: FormData): Promise<void> {
  const parsed = ids
    .extend({ shareId: z.uuid(), state: z.enum(['pending', 'sent', 'delivered', 'failed', 'unknown']), evidence: z.string().trim().max(500).optional() })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect('/projects');
  const r = await callDoor(await createClient(), 'projects', 'p4q_mark_share_delivery', { p_share_id: parsed.data.shareId, p_state: parsed.data.state, p_evidence: parsed.data.evidence || null });
  back(parsed.data.projectId, r.ok ? `Delivery: ${r.row.outcome}` : 'Delivery: could not be saved');
}

/** QAP-043: attach an uploaded file (screenshot, recording, log, report) to a QA run. The file is stored first, then the door records it. */
export async function attachQaEvidenceAction(formData: FormData): Promise<void> {
  const parsed = ids
    .extend({
      runId: z.uuid(),
      kind: z.enum(['screenshot', 'recording', 'log', 'report', 'other']),
      checkKey: z.string().trim().max(200).optional(),
      note: z.string().trim().max(500).optional(),
    })
    .safeParse(Object.fromEntries(formData));
  const file = formData.get('file');
  if (!parsed.success) redirect('/projects');
  if (!(file instanceof File) || file.size === 0) back(parsed.data.projectId, 'Evidence: choose a file to upload');
  const { attachQaEvidence } = await import('./evidence-service');
  const result = await attachQaEvidence({ projectId: parsed.data.projectId, runId: parsed.data.runId, kind: parsed.data.kind, file: file as File, checkKey: parsed.data.checkKey || null, note: parsed.data.note || null });
  back(parsed.data.projectId, result.ok ? 'Evidence: attached' : `Evidence: ${result.error.message}`);
}

/** QAP-019: QA is owed a retest of the exact fix build (FIX_READY -> QA_RETEST). */
export async function requestDefectRetestAction(formData: FormData): Promise<void> {
  const parsed = ids.extend({ defectId: z.uuid() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect('/projects');
  const r = await callDoor(await createClient(), 'projects', 'p4s_request_defect_retest', { p_defect_id: parsed.data.defectId });
  back(parsed.data.projectId, r.ok ? `Retest: ${r.row.outcome}` : 'Retest: could not be saved');
}

/** QAP-019: an Admin defers a defect, with a reason. The database refuses anyone else. */
export async function deferDefectAction(formData: FormData): Promise<void> {
  const parsed = ids
    .extend({ defectId: z.uuid(), reason: z.string().trim().min(10).max(1000), until: z.string().trim().optional() })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect('/projects');
  const until = parsed.data.until && /^\d{4}-\d{2}-\d{2}$/.test(parsed.data.until) ? parsed.data.until : null;
  const r = await callDoor(await createClient(), 'projects', 'p4s_defer_defect', { p_defect_id: parsed.data.defectId, p_reason: parsed.data.reason, p_until: until });
  back(parsed.data.projectId, r.ok ? `Deferral: ${r.row.outcome}` : 'Deferral: could not be saved');
}

/** QAP-019: an Admin brings a deferred defect back. */
export async function undeferDefectAction(formData: FormData): Promise<void> {
  const parsed = ids.extend({ defectId: z.uuid() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect('/projects');
  const r = await callDoor(await createClient(), 'projects', 'p4s_undefer_defect', { p_defect_id: parsed.data.defectId });
  back(parsed.data.projectId, r.ok ? `Deferral: ${r.row.outcome}` : 'Deferral: could not be saved');
}
