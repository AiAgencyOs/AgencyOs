'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';
import { syncDeliverableDecision } from '@/modules/projects/service';
import { syncProposalDecision } from '@/modules/sales/service';

import { getApproval } from './queries';
import { decideApproval, upsertApprovalPolicy } from './service';

/** Server Actions for the approval centre — thin wrappers over service.ts. */

/**
 * Settle one pending request.
 *
 * Every refusal the engine can produce is surfaced as written rather than
 * flattened to "something went wrong": whether a request needs a different
 * role, was already answered by somebody else, or needs the client's evidence
 * attached are three different things for the person looking at the screen,
 * and only one of them is worth trying again.
 *
 * The decision itself is checked under a lock in `approvals.decide_approval`.
 * Nothing here decides anything, and deliberately so — a role check in this
 * file would be a read taken before a write somebody else may land first.
 */
export async function decideApprovalAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const decision = String(formData.get('decision') ?? '');
  const note = String(formData.get('note') ?? '').trim();
  const evidenceRef = String(formData.get('evidenceRef') ?? '').trim();

  if (decision !== 'approved' && decision !== 'rejected' && decision !== 'changes_requested') {
    return { status: 'error', message: 'That is not a decision this request accepts.' };
  }

  const result = await decideApproval({
    requestId: String(formData.get('requestId') ?? ''),
    decision,
    ...(note ? { note } : {}),
    ...(evidenceRef ? { evidenceRef } : {}),
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.error.message,
      ...(result.error.details ? { fieldErrors: result.error.details } : {}),
    };
  }

  revalidatePath('/approvals');

  const carried = await carryDecisionToSubject(result.data.requestId);

  const said =
    result.data.state === 'approved'
      ? 'Approved.'
      : result.data.state === 'rejected'
        ? 'Rejected.'
        : 'Changes requested.';

  // Said plainly rather than swallowed. The decision is durable either way,
  // and somebody who is told only "Approved." would go looking for a quotation
  // that still reads `pending_approval` and have no idea why.
  return {
    status: 'success',
    message: carried
      ? said
      : `${said} The item it answers could not be updated — reload it and try again.`,
  };
}

/**
 * Carry a settled decision back onto the thing it was about.
 *
 * `sync_proposal_decision` and `sync_deliverable_decision` are both deliberate
 * *pulls* rather than triggers on `approval_requests` — a trigger there would
 * make settling an invoice reach into the delivery module, which is the
 * coupling ARCHITECTURE.md §3.2 exists to prevent. Both migrations say in as
 * many words that "the caller that settles it calls this next", and until now
 * **nothing did**: `syncDeliverableDecision` had no caller anywhere in the
 * application, so a client's answer was recorded in the engine and the
 * deliverable stayed `in_review` forever. That is G-112, closed here because
 * the quotation loop needs the identical mechanism and writing this dispatch
 * while deliberately omitting the case already known to be broken would be
 * worse than either fixing or recording it.
 *
 * This is the composition layer's job, not a module's. The approvals module
 * still knows nothing about quotations or deliverables; an action does, which
 * is what actions are for.
 *
 * Returns true when there was nothing to carry or it was carried, false when
 * the subject could not be updated. A failure here does not undo the decision:
 * the decision is the durable record, and the sync is idempotent and can be
 * re-run by settling nothing at all.
 */
async function carryDecisionToSubject(requestId: string): Promise<boolean> {
  const request = await getApproval(requestId);
  if (!request?.subject_id) return true;

  switch (request.subject_type) {
    case 'proposal': {
      const synced = await syncProposalDecision(request.subject_id);
      return synced.ok;
    }
    case 'deliverable': {
      const synced = await syncDeliverableDecision(request.subject_id);
      return synced.ok;
    }
    // Every other subject type gates by reading the engine directly — an
    // invoice checks its deliverable's status, a refund checks its own
    // request — so there is nothing to carry.
    default:
      return true;
  }
}

/**
 * Set who must approve a subject type above an amount — ADM-08b.
 *
 * `upsertApprovalPolicy` has existed since the engine landed, and
 * `violatesMoneyFloor` was written *"so a form can say why before submitting"*.
 * **No form was ever written.** So on a new deployment there is no policy at
 * all, `sales.submit_proposal` answers `no_policy`, and the message an owner
 * reads — *"An owner sets one before this can be approved"* — names an action
 * the product does not offer. The whole of ADM-07's close path stops there.
 *
 * It lives on the SETTINGS page rather than on /approvals, and that is the approvals
 * page's own reasoning honoured rather than overturned: *"changing who may
 * approve what is an authority change… not a screen a queue view should hand
 * out."* The queue still hands nothing out. The owner's configuration surface,
 * which is already owner-gated and already audited, is where it belongs.
 */
export async function upsertApprovalPolicyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const minAmount = Number(formData.get('minAmountMinor') ?? 0);

  const result = await upsertApprovalPolicy({
    subjectType: String(formData.get('subjectType') ?? '') as never,
    requiredRole: String(formData.get('requiredRole') ?? '') as never,
    // Rupees on the screen, minor units in the column — the same conversion
    // every other money field in this application makes, and in one direction
    // only so a form cannot introduce a second representation.
    minAmountMinor: Number.isFinite(minAmount) ? Math.round(minAmount * 100) : 0,
    slaHours: Number(formData.get('slaHours') ?? 24),
    audience: 'internal',
    ...(String(formData.get('note') ?? '').trim()
      ? { note: String(formData.get('note')).trim() }
      : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings');
  revalidatePath('/approvals');
  return { status: 'success', message: 'Approval policy saved.' };
}
