'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { decideApproval } from './service';

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

  const said =
    result.data.state === 'approved'
      ? 'Approved.'
      : result.data.state === 'rejected'
        ? 'Rejected.'
        : 'Changes requested.';

  return { status: 'success', message: said };
}
