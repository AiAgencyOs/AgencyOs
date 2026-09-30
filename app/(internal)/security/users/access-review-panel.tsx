'use client';

import { useActionState } from 'react';

import { recordAccessReviewAction } from '@/modules/identity/access-reviews-actions';
import type { AccessReviewRow } from '@/modules/identity/access-reviews-queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass } from '@/ui';

/**
 * Review access — SCR-069. One row per internal membership: who, which
 * roles, when their access was last reviewed and what was decided, and the
 * two answers a reviewer can give: confirm, or ask for it to go (with a
 * note). A revoke request records the judgement; suspending is the
 * membership's own door on the roster above. Owner and ops_admin.
 */
export type ReviewableMember = {
  membershipId: string;
  fullName: string;
  email: string;
  role: string;
  secondaryRoles: string[];
  status: 'active' | 'suspended';
  lastReview: (AccessReviewRow & { reviewedAtLabel: string }) | null;
};

function ReviewForm({ membershipId }: { membershipId: string }) {
  const [state, action, pending] = useActionState(recordAccessReviewAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="membershipId" value={membershipId} />
      <input name="note" maxLength={1000} placeholder="note (required to request revocation)" aria-label="Review note" className={`${inputClass} h-7 w-64 text-xs`} />
      <button type="submit" name="decision" value="confirmed" disabled={pending} className={buttonClass('secondary', 'sm')}>
        Confirm access
      </button>
      <button type="submit" name="decision" value="revoke_requested" disabled={pending} className={buttonClass('danger', 'sm')}>
        Request revocation
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full text-xs" />
    </form>
  );
}

export function AccessReviewPanel({ members }: { members: ReviewableMember[] }) {
  if (members.length === 0) {
    return <p className="px-4 py-4 text-[13px] text-muted sm:px-5">No internal membership to review.</p>;
  }

  return (
    <ul className="divide-y divide-line">
      {members.map((m) => (
        <li key={m.membershipId} className="flex flex-col gap-2 px-4 py-3 text-[13px] sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{m.fullName}</span>
              <span className="text-xs text-muted">{m.email}</span>
              <Badge tone="brand">{m.role.replace('_', ' ')}</Badge>
              {m.secondaryRoles.map((r) => (
                <Badge key={r} tone="info">
                  +{r.replace('_', ' ')}
                </Badge>
              ))}
              <Badge tone={m.status === 'active' ? 'success' : 'warning'}>{m.status}</Badge>
            </span>
            <span className="text-xs text-muted">
              {m.lastReview ? (
                <>
                  last reviewed {m.lastReview.reviewedAtLabel} by {m.lastReview.reviewerName ?? 'unknown'} —{' '}
                  <Badge tone={m.lastReview.decision === 'confirmed' ? 'success' : 'danger'}>{m.lastReview.decision.replace('_', ' ')}</Badge>
                  {m.lastReview.note ? ` “${m.lastReview.note}”` : ''}
                </>
              ) : (
                'never reviewed'
              )}
            </span>
          </div>
          <ReviewForm membershipId={m.membershipId} />
        </li>
      ))}
    </ul>
  );
}
