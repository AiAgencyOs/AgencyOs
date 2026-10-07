import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { reasonForPriorStatus, type DesignerActivationReason } from '@/modules/orchestrator/designer-activation';

import { callDoor } from './door';

type Admin = ReturnType<typeof createAdminClient>;

/** The database's three activation reasons for a redraft, from the registry-level reason the Orchestrator already names. */
export function databaseReasonFor(reason: DesignerActivationReason): 'client_change' | 'admin_edit' | 'qa_correction' | null {
  switch (reason) {
    case 'client_visual_revision':
      return 'client_change';
    case 'admin_edit':
      return 'admin_edit';
    case 'design_qa_defect':
      return 'qa_correction';
    default:
      return null;
  }
}

export type DesignerGate = { allowed: true; reason: string } | { allowed: false; waiting: boolean; reason: string };

/**
 * ORCH-013 / ORCH-021. Call this at the top of `ui_designer:reviseUIVersion` for a client change: it names the activation reason (`reasonForPriorStatus`, which had no
 * production caller), and asks the database whether the PM's classification lets the Designer redraft at all. New scope, a clarification, a direction change and a
 * rejected request do not; an unclassified request WAITS (the classifier runs in parallel and the job can be retried), it is never assumed to be a correction.
 */
export async function gateDesignerRevision(admin: Admin, input: { decisionId: string; priorStatus: string }): Promise<DesignerGate> {
  const registryReason = reasonForPriorStatus(input.priorStatus);
  const reason = registryReason ? databaseReasonFor(registryReason) : null;
  if (!reason) return { allowed: false, waiting: false, reason: `a version left in ${input.priorStatus} is not a design condition` };

  const result = await callDoor(admin, 'projects', 'p4q_decide_designer_revision', { p_decision_id: input.decisionId, p_activation_reason: reason });
  if (!result.ok) return { allowed: false, waiting: true, reason: `the gate did not answer: ${result.message}` };
  const outcome = result.row.outcome ?? 'no answer';
  const text = typeof result.row.reason === 'string' ? result.row.reason : outcome;
  if (outcome === 'awaiting_classification') return { allowed: false, waiting: true, reason: text };
  if (outcome === 'decided' || outcome === 'already_decided') return result.row.allowed === true ? { allowed: true, reason: text } : { allowed: false, waiting: false, reason: text };
  return { allowed: false, waiting: false, reason: `the gate answered ${outcome}` };
}
