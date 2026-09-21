import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { APPROVAL_SUBJECT_TYPES, APPROVER_ROLES } from '@/modules/approvals/schema';

import { ApprovalPolicyForm } from '../forms';

export const metadata: Metadata = { title: 'Settings — Approvals' };

/**
 * ADM-08b, and the reason nothing could be quoted on a fresh deployment:
 * `sales.submit_proposal` answers `no_policy` when nothing covers
 * quotations, and the message it produces — "An owner sets one before
 * this can be approved" — named an action the product offered nowhere.
 *
 * Kept off the /approvals queue deliberately: that page's own comment says
 * changing who may approve what is "not a screen a queue view should hand
 * out", and it is right — this is the owner's configuration surface,
 * already owner-gated and already audited.
 */
export default async function SettingsApprovalsPage() {
  await requireInternal('/settings');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Who must approve what</h2>
        <p className="text-xs text-muted">
          A quotation cannot be submitted until a policy covers it — with none, the queue would
          hold a quote nobody is named to answer. Policies read as a ladder: the highest rung at
          or below the amount decides.
        </p>
        <ApprovalPolicyForm subjectTypes={APPROVAL_SUBJECT_TYPES} roles={APPROVER_ROLES} />
      </div>
    </div>
  );
}
