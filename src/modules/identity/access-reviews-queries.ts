import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { AccessReviewDecision } from './access-reviews-schema';

/** SCR-069 — the latest access review per membership, for the roster. Read-only. */
export type AccessReviewRow = {
  membershipId: string;
  decision: AccessReviewDecision;
  note: string | null;
  reviewedAt: string;
  reviewerName: string | null;
};

export async function readLatestAccessReviews(): Promise<Map<string, AccessReviewRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('security')
    .from('access_reviews')
    .select('membership_id, decision, note, reviewed_at, reviewer_id')
    .order('reviewed_at', { ascending: false })
    .limit(1_000);
  if (error) unreadable('readLatestAccessReviews', error);

  const rows = data ?? [];
  const ids = [...new Set(rows.map((r) => r.reviewer_id).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', ids);
    if (usersError) unreadable('readLatestAccessReviews.users', usersError);
    for (const u of users ?? []) names.set(u.id, u.full_name ?? u.email);
  }

  const latest = new Map<string, AccessReviewRow>();
  for (const r of rows) {
    if (latest.has(r.membership_id)) continue;
    latest.set(r.membership_id, {
      membershipId: r.membership_id,
      decision: r.decision as AccessReviewDecision,
      note: r.note,
      reviewedAt: r.reviewed_at,
      reviewerName: r.reviewer_id ? (names.get(r.reviewer_id) ?? r.reviewer_id.slice(0, 8)) : null,
    });
  }
  return latest;
}
