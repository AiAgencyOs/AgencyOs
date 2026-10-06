import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What staff see of the QA specialists' PROPOSALS for one project, from the STORED state. Every read is guarded (G-054): a failed read is `unreadable`,
 * never rendered as "no proposals". A proposal is shown as a proposal: nothing here is a result until an independent person accepts it.
 * The qa tables written for this slice are not in the generated database types yet, so the reads go through a minimal structural type.
 */

type Row = Record<string, unknown>;
type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): Res & {
        order(column: string, options: { ascending: boolean }): Res & { limit(n: number): Res };
        limit(n: number): Res;
      };
      in(column: string, values: string[]): Res & { limit(n: number): Res };
    };
  };
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

export type QaSpecialistFindingRow = {
  id: string;
  agent: string;
  kind: string;
  category: string;
  caseTitle: string | null;
  casePriority: string | null;
  proposedResult: string | null;
  reason: string;
  detail: string | null;
  evidenceRefs: string[];
  commit: string;
  environment: string | null;
  createdAt: string;
  /** The viewer asked for this run: the database will refuse their decision, so the form is not offered. */
  viewerAsked: boolean;
  decision: { decision: string; note: string | null; recordedOutcome: string; decidedAt: string } | null;
};
export type QaSpecialistView = {
  /** Scheduled QA jobs a specialist can be asked about (not cancelled). */
  jobs: { id: string; category: string; specialist: string; status: string; reason: string }[];
  /** The newest release candidate, when one exists and is current. */
  candidate: { id: string; version: number; status: string } | null;
  findings: QaSpecialistFindingRow[];
};

export async function readQaSpecialistView(projectId: string): Promise<QaSpecialistView> {
  const context = await requireInternal();
  const qa = (await createClient()).schema('qa') as unknown as Loose;

  const [jobs, candidates, findings] = await Promise.all([
    qa.from('qa_jobs').select('id, category, specialist, status, reason').eq('project_id', projectId).order('created_at', { ascending: true }).limit(20),
    qa.from('release_candidates').select('id, version, status').eq('project_id', projectId).order('version', { ascending: false }).limit(1),
    qa.from('specialist_findings').select('id, agent_key, kind, category, case_id, proposed_result, reason, detail, evidence_refs, commit_ref, claimed_environment, requested_by, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(100),
  ]);
  if (jobs.error) unreadable('readQaSpecialistView.jobs', jobs.error);
  if (candidates.error) unreadable('readQaSpecialistView.candidate', candidates.error);
  if (findings.error) unreadable('readQaSpecialistView.findings', findings.error);

  const findingRows = rows(findings.data);
  const ids = findingRows.map((f) => String(f.id));
  const caseIds = [...new Set(findingRows.map((f) => str(f.case_id)).filter((c): c is string => c !== null))];
  const [decisions, cases] = await Promise.all([
    ids.length ? qa.from('specialist_finding_decisions').select('finding_id, decision, note, recorded_outcome, decided_at').in('finding_id', ids).limit(200) : Promise.resolve({ data: [], error: null }),
    caseIds.length ? qa.from('phase6_cases').select('id, title, priority').in('id', caseIds).limit(200) : Promise.resolve({ data: [], error: null }),
  ]);
  if (decisions.error) unreadable('readQaSpecialistView.decisions', decisions.error);
  if (cases.error) unreadable('readQaSpecialistView.cases', cases.error);

  const decisionBy = new Map(rows(decisions.data).map((d) => [String(d.finding_id), d] as const));
  const caseBy = new Map(rows(cases.data).map((c) => [String(c.id), c] as const));
  const candRow = rows(candidates.data)[0] ?? null;
  return {
    jobs: rows(jobs.data)
      .filter((j) => j.status !== 'cancelled')
      .map((j) => ({ id: String(j.id), category: String(j.category), specialist: String(j.specialist), status: String(j.status), reason: String(j.reason) })),
    candidate: candRow && candRow.status !== 'stale' && candRow.status !== 'superseded' ? { id: String(candRow.id), version: Number(candRow.version), status: String(candRow.status) } : null,
    findings: findingRows.map((f) => {
      const d = decisionBy.get(String(f.id));
      const c = caseBy.get(String(f.case_id));
      return {
        id: String(f.id),
        agent: String(f.agent_key),
        kind: String(f.kind),
        category: String(f.category),
        caseTitle: c ? String(c.title) : null,
        casePriority: c ? String(c.priority) : null,
        proposedResult: str(f.proposed_result),
        reason: String(f.reason),
        detail: str(f.detail),
        evidenceRefs: Array.isArray(f.evidence_refs) ? f.evidence_refs.map(String) : [],
        commit: String(f.commit_ref),
        environment: str(f.claimed_environment),
        createdAt: String(f.created_at),
        viewerAsked: f.requested_by === context.userId,
        decision: d ? { decision: String(d.decision), note: str(d.note), recordedOutcome: String(d.recorded_outcome), decidedAt: String(d.decided_at) } : null,
      };
    }),
  };
}
