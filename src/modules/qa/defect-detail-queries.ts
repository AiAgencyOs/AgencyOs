import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { lastSeverityChange, resolutionWithoutSeverityLines, type SeverityChange } from './defect-severity-trail';
import type { Defect } from './types';

/**
 * SCR-047 — one bug, in full, for its own page.
 *
 * Everything the PDF lists under "Bug detail" comes from foreign keys the
 * row already holds: the version it was found on (`deliverable_id`), the run
 * that found it (`run_id`), the task it is about (`task_id`), the build its
 * fix lands in (`build_id`, 20261001160000), who has it (`assignee_id`), and
 * the evidence list (`qa.defect_evidence`, same migration) beside the
 * original `evidence_url`. The fix / retest trail is `readDefectHistory`'s,
 * read by the page; the retest assignments are the rows `qa.assign_retest`
 * wrote. Every read refuses rather than rendering a calm, wrong page.
 */

export type DefectEvidenceRow = { id: string; kind: 'url' | 'note'; value: string; addedBy: string | null; addedAt: string };

export type DefectRetestRow = { id: string; retesterId: string; assignedBy: string | null; note: string | null; createdAt: string };

export type DefectDetail = {
  defect: Defect & { projectId: string; reportedBy: string | null; verifiedBy: string | null; updatedAt: string };
  /** The newest `Severity a → b: reason` line triage appended, or none. */
  lastSeverityChange: SeverityChange | null;
  /** The resolution trail without the severity lines. */
  resolutionNotes: string | null;
  task: { id: string; title: string; status: string } | null;
  build: { id: string; version: number; title: string; status: string } | null;
  foundOn: { id: string; kind: string; version: number; title: string } | null;
  run: { id: string; suite: string; status: string; executedAt: string } | null;
  evidence: DefectEvidenceRow[];
  retests: DefectRetestRow[];
};

const SELECT =
  'id, project_id, severity, status, title, reproduction, expected, actual, environment, evidence_url, resolution, deliverable_id, verified_at, verified_by, created_at, updated_at, assignee_id, reported_by, task_id, run_id, build_id';

/** Null when no such defect is on this project — the page answers notFound. */
export async function readDefectDetail(projectId: string, defectId: string): Promise<DefectDetail | null> {
  const supabase = await createClient();

  const { data: d, error } = await supabase
    .schema('qa')
    .from('defects')
    .select(SELECT)
    .eq('id', defectId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) unreadable('readDefectDetail', error);
  if (!d) return null;

  const deliverableIds = [d.deliverable_id, d.build_id].filter((id): id is string => id !== null);

  const [task, deliverables, run, evidence, retests] = await Promise.all([
    d.task_id
      ? supabase.schema('projects').from('tasks').select('id, title, status').eq('id', d.task_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    deliverableIds.length > 0
      ? supabase.schema('projects').from('deliverables').select('id, kind, version, title, status').in('id', deliverableIds)
      : Promise.resolve({ data: [] as { id: string; kind: string; version: number; title: string; status: string }[], error: null }),
    d.run_id
      ? supabase.schema('qa').from('test_runs').select('id, suite, status, executed_at').eq('id', d.run_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.schema('qa').from('defect_evidence').select('id, kind, value, added_by, added_at').eq('defect_id', d.id).order('added_at', { ascending: true }),
    supabase.schema('qa').from('retest_assignments').select('id, retester_id, assigned_by, note, created_at').eq('defect_id', d.id).order('created_at', { ascending: true }),
  ]);
  if (task.error) unreadable('readDefectDetail.task', task.error);
  if (deliverables.error) unreadable('readDefectDetail.deliverables', deliverables.error);
  if (run.error) unreadable('readDefectDetail.run', run.error);
  if (evidence.error) unreadable('readDefectDetail.evidence', evidence.error);
  if (retests.error) unreadable('readDefectDetail.retests', retests.error);

  const byId = new Map((deliverables.data ?? []).map((x) => [x.id, x]));
  const build = d.build_id ? byId.get(d.build_id) : undefined;
  const foundOn = d.deliverable_id ? byId.get(d.deliverable_id) : undefined;

  return {
    defect: {
      id: d.id,
      severity: d.severity,
      status: d.status,
      title: d.title,
      reproduction: d.reproduction,
      expected: d.expected,
      actual: d.actual,
      environment: d.environment,
      evidence_url: d.evidence_url,
      resolution: d.resolution,
      deliverable_id: d.deliverable_id,
      verified_at: d.verified_at,
      created_at: d.created_at,
      assignee_id: d.assignee_id,
      task_id: d.task_id,
      run_id: d.run_id,
      build_id: d.build_id,
      projectId: d.project_id,
      reportedBy: d.reported_by,
      verifiedBy: d.verified_by,
      updatedAt: d.updated_at,
    },
    lastSeverityChange: lastSeverityChange(d.resolution),
    resolutionNotes: resolutionWithoutSeverityLines(d.resolution),
    task: task.data ? { id: task.data.id, title: task.data.title, status: task.data.status } : null,
    build: build ? { id: build.id, version: build.version, title: build.title, status: build.status } : null,
    foundOn: foundOn ? { id: foundOn.id, kind: foundOn.kind, version: foundOn.version, title: foundOn.title } : null,
    run: run.data ? { id: run.data.id, suite: run.data.suite, status: run.data.status, executedAt: run.data.executed_at } : null,
    evidence: (evidence.data ?? []).map((e) => ({ id: e.id, kind: e.kind as 'url' | 'note', value: e.value, addedBy: e.added_by, addedAt: e.added_at })),
    retests: (retests.data ?? []).map((r) => ({ id: r.id, retesterId: r.retester_id, assignedBy: r.assigned_by, note: r.note, createdAt: r.created_at })),
  };
}
