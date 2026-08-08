import type { Database } from '@/lib/db/types';

type LeadRow = Database['crm']['Tables']['leads']['Row'];

/**
 * A lead as the pipeline list renders it.
 *
 * Derived from the generated row type rather than restated, so a column rename
 * in a migration breaks the build here instead of silently rendering blanks.
 * Only the columns the list actually shows are carried — a list view has no
 * business shipping `requirements` or `score_reasons` to the client.
 */
export type LeadListItem = Pick<
  LeadRow,
  'id' | 'title' | 'status' | 'score' | 'source' | 'created_at'
> & {
  contact: { fullName: string; company: string | null } | null;
};
