import type { Database } from '@/lib/db/types';

type DefectRow = Database['qa']['Tables']['defects']['Row'];

/** A defect as the project's QA list renders it. */
export type Defect = Pick<
  DefectRow,
  | 'id'
  | 'severity'
  | 'status'
  | 'title'
  | 'reproduction'
  | 'expected'
  | 'actual'
  | 'environment'
  | 'evidence_url'
  | 'resolution'
  | 'deliverable_id'
  | 'verified_at'
  | 'created_at'
>;

/** The counts a readiness gate will need, once ADM-19 says what the gate is. */
export type ProjectQuality = {
  open_blockers: number;
  open_majors: number;
  open_minors: number;
  unverified: number;
  total: number;
};
