import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { ageInDays, exceptionState, type ExceptionState } from './phase-six-extra-logic';

/**
 * Read-only Phase 6 dashboards over facts that already exist: the per-category evidence matrix for the current release candidate (and whether each result
 * is for THIS commit), defect aging, the retest queue (fixed, awaiting verification, and who was asked), the exception expiry list and the clarification
 * history. Nothing here is computed into a verdict: a stale result is shown as stale, never promoted. Every read is guarded (G-054).
 */

type Row = Record<string, unknown>;
const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const CATEGORIES = ['functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression'] as const;
const OPEN_DEFECT = new Set(['open', 'needs_evidence', 'not_reproduced']);

export type EvidenceMatrixRow = {
  category: string;
  status: 'pass' | 'fail' | 'blocked' | 'no_result';
  evidenceRef: string | null;
  reason: string | null;
  /** The result was recorded against another commit than the candidate's: it is not evidence for this candidate. */
  stale: boolean;
  recordedAt: string | null;
  cases: { total: number; passed: number; failed: number };
};
export type AgingDefect = { id: string; title: string; status: string; sLevel: number | null; ageDays: number };
export type RetestItem = { id: string; title: string; fixedAt: string | null; retesterId: string | null; assignmentNote: string | null; waitingDays: number };
export type ExceptionRow = { id: string; gate: string; status: string; owner: string; expiresAt: string; state: ExceptionState };
export type ClarificationHistoryRow = { id: string; question: string; status: string; answer: string | null; askedAt: string; answeredAt: string | null };

export type PhaseSixExtra = {
  candidate: { id: string; version: number; commit: string } | null;
  matrix: EvidenceMatrixRow[];
  aging: AgingDefect[];
  retestQueue: RetestItem[];
  exceptions: ExceptionRow[];
  clarifications: ClarificationHistoryRow[];
};

export async function getPhaseSixExtra(projectId: string): Promise<PhaseSixExtra> {
  const supabase = await createClient();
  const qa = supabase.schema('qa');
  const now = Date.now();
  const [cands, defects, clars, plans] = await Promise.all([
    qa.from('release_candidates' as never).select('id, version, commit_ref').eq('project_id', projectId).order('version', { ascending: false }).limit(1),
    qa.from('defects' as never).select('id, title, status, s_level, created_at, fixed_at').eq('project_id', projectId).in('status', ['open', 'needs_evidence', 'not_reproduced', 'fixed']).order('created_at', { ascending: true }).limit(200),
    qa.from('qa_clarifications' as never).select('id, question, status, answer, created_at, answered_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(100),
    qa.from('master_test_plans' as never).select('id').eq('project_id', projectId).order('version', { ascending: false }).limit(1),
  ]);
  if (cands.error) unreadable('phase six extra candidate', cands.error);
  if (defects.error) unreadable('phase six extra defects', defects.error);
  if (clars.error) unreadable('phase six extra clarifications', clars.error);
  if (plans.error) unreadable('phase six extra plan', plans.error);

  const cand = rows(cands.data)[0] ?? null;
  const candidate = cand ? { id: String(cand.id), version: Number(cand.version), commit: String(cand.commit_ref) } : null;
  const planId = rows(plans.data)[0]?.id ? String(rows(plans.data)[0]!.id) : null;
  const fixedIds = rows(defects.data).filter((d) => d.status === 'fixed').map((d) => String(d.id));

  const [results, cases, exceptionRows, assignments] = await Promise.all([
    candidate ? qa.from('category_results' as never).select('category, status, commit_ref, evidence_ref, reason, recorded_at').eq('candidate_id', candidate.id).limit(20) : Promise.resolve({ data: [], error: null }),
    planId ? qa.from('phase6_cases' as never).select('category, status').eq('plan_id', planId).limit(1000) : Promise.resolve({ data: [], error: null }),
    candidate ? qa.from('release_exceptions' as never).select('id, gate, status, owner, expires_at').eq('candidate_id', candidate.id).order('expires_at', { ascending: true }).limit(50) : Promise.resolve({ data: [], error: null }),
    fixedIds.length > 0 ? qa.from('retest_assignments' as never).select('defect_id, retester_id, note, created_at').in('defect_id', fixedIds).order('created_at', { ascending: false }).limit(500) : Promise.resolve({ data: [], error: null }),
  ]);
  if (results.error) unreadable('phase six extra category results', results.error);
  if (cases.error) unreadable('phase six extra cases', cases.error);
  if (exceptionRows.error) unreadable('phase six extra exceptions', exceptionRows.error);
  if (assignments.error) unreadable('phase six extra retest assignments', assignments.error);

  const byCategory = new Map(rows(results.data).map((r) => [String(r.category), r]));
  const counts = new Map<string, { total: number; passed: number; failed: number }>();
  for (const c of rows(cases.data)) {
    const k = String(c.category);
    const cur = counts.get(k) ?? { total: 0, passed: 0, failed: 0 };
    cur.total += 1;
    if (c.status === 'pass') cur.passed += 1;
    if (c.status === 'fail') cur.failed += 1;
    counts.set(k, cur);
  }
  const matrix: EvidenceMatrixRow[] = CATEGORIES.map((category) => {
    const r = byCategory.get(category) ?? null;
    const status = r && (r.status === 'pass' || r.status === 'fail' || r.status === 'blocked') ? r.status : 'no_result';
    return {
      category,
      status,
      evidenceRef: r ? str(r.evidence_ref) : null,
      reason: r ? str(r.reason) : null,
      stale: Boolean(r && candidate && String(r.commit_ref) !== candidate.commit),
      recordedAt: r ? str(r.recorded_at) : null,
      cases: counts.get(category) ?? { total: 0, passed: 0, failed: 0 },
    };
  });

  const latestAssignment = new Map<string, Row>();
  for (const a of rows(assignments.data)) if (!latestAssignment.has(String(a.defect_id))) latestAssignment.set(String(a.defect_id), a);

  const all = rows(defects.data);
  return {
    candidate,
    matrix,
    aging: all
      .filter((d) => OPEN_DEFECT.has(String(d.status)))
      .map((d) => ({ id: String(d.id), title: String(d.title), status: String(d.status), sLevel: typeof d.s_level === 'number' ? d.s_level : null, ageDays: ageInDays(String(d.created_at), now) }))
      .sort((a, b) => b.ageDays - a.ageDays),
    retestQueue: all
      .filter((d) => d.status === 'fixed')
      .map((d) => {
        const a = latestAssignment.get(String(d.id)) ?? null;
        return { id: String(d.id), title: String(d.title), fixedAt: str(d.fixed_at), retesterId: a ? str(a.retester_id) : null, assignmentNote: a ? str(a.note) : null, waitingDays: ageInDays(String(d.fixed_at ?? d.created_at), now) };
      })
      .sort((a, b) => b.waitingDays - a.waitingDays),
    exceptions: rows(exceptionRows.data).map((e) => ({ id: String(e.id), gate: String(e.gate), status: String(e.status), owner: String(e.owner), expiresAt: String(e.expires_at), state: exceptionState(String(e.status), String(e.expires_at), now) })),
    clarifications: rows(clars.data).map((c) => ({ id: String(c.id), question: String(c.question), status: String(c.status), answer: str(c.answer), askedAt: String(c.created_at), answeredAt: str(c.answered_at) })),
  };
}
