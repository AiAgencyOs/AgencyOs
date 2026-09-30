import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type DesignReviewComment = { id: string; subjectType: 'theme_option' | 'deliverable'; subjectId: string; authorName: string; body: string; createdAt: string };

/** SCR-036 — every comment on the project's design options and design deliverables, oldest first, grouped by subject. */
export async function readDesignReviewComments(projectId: string): Promise<Map<string, DesignReviewComment[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('design_review_comments')
    .select('id, subject_type, subject_id, author_id, body, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) unreadable('readDesignReviewComments', error);
  const rows = data ?? [];
  const authorIds = [...new Set(rows.map((r) => r.author_id).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (authorIds.length > 0) {
    const people = await supabase.schema('core').from('users').select('id, full_name, email').in('id', authorIds);
    if (people.error) unreadable('readDesignReviewComments.authors', people.error);
    for (const u of people.data ?? []) names.set(u.id, u.full_name || u.email);
  }
  const out = new Map<string, DesignReviewComment[]>();
  for (const r of rows) {
    const c: DesignReviewComment = {
      id: r.id,
      subjectType: r.subject_type === 'deliverable' ? 'deliverable' : 'theme_option',
      subjectId: r.subject_id,
      authorName: r.author_id ? (names.get(r.author_id) ?? 'Former member') : 'Former member',
      body: r.body,
      createdAt: r.created_at,
    };
    out.set(r.subject_id, [...(out.get(r.subject_id) ?? []), c]);
  }
  return out;
}
