'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import type { ACCESS_REVIEW_DECISIONS } from './access-reviews-schema';
import { recordAccessReview } from './access-reviews-service';

/** SCR-069 — the users & roles page's "Review access" form. Refusals are shown as written. */
export async function recordAccessReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await recordAccessReview({
    membershipId: String(formData.get('membershipId') ?? ''),
    decision: String(formData.get('decision') ?? '') as (typeof ACCESS_REVIEW_DECISIONS)[number],
    note: String(formData.get('note') ?? '').trim() || undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/security/users');
  revalidatePath('/security');
  return {
    status: 'success',
    message:
      result.data.decision === 'confirmed'
        ? 'Access confirmed. Audited.'
        : 'Revocation requested and recorded — suspend the membership below to act on it. Audited.',
  };
}
