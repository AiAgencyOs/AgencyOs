import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { MetricResultRow } from './budget-comparison';

/**
 * SCR-046's run page — everything one run says about itself: who ran it
 * where, every piece of evidence, the per-case results, the defects it
 * found, the metrics attached to it and the chain of reruns either side.
 * One project-scoped read; a run that is not on the project is null, so the
 * page answers 404 rather than showing another project's evidence.
 */

export type RunEvidenceItem = {
  id: string;
  kind: string;
  label: string | null;
  value: string;
  addedAt: string;
  addedBy: string | null;
};

export type RunChainEntry = { id: string; suite: string; status: string; passed: number; failed: number; blocked: number; executedAt: string; relation: 'earlier' | 'later' };

export type RunDetail = {
  id: string;
  suite: string;
  status: string;
  deliverableId: string;
  buildTitle: string | null;
  buildVersion: number | null;
  environment: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
  startedAt: string | null;
  endedAt: string | null;
  executedAt: string;
  evidenceUrl: string | null;
  perfNotes: string | null;
  tester: { kind: 'person'; name: string } | { kind: 'agent'; key: string } | null;
  recordedBy: string | null;
  evidence: RunEvidenceItem[];
  cases: { id: string; testPlanItemId: string; status: string; notes: string | null; evidenceUrl: string | null }[];
  defects: { id: string; title: string; severity: string; status: string }[];
  metrics: MetricResultRow[];
  chain: RunChainEntry[];
};

export async function readRunDetail(projectId: string, runId: string): Promise<RunDetail | null> {
  const supabase = await createClient();

  const { data: run, error } = await supabase
    .schema('qa')
    .from('test_runs')
    .select(
      'id, suite, status, deliverable_id, environment, device, browser, os, total, passed, failed, skipped, blocked, started_at, ended_at, executed_at, evidence_url, perf_notes, executed_by, executed_by_agent, tester_id, rerun_of',
    )
    .eq('project_id', projectId)
    .eq('id', runId)
    .maybeSingle();
  if (error) unreadable('readRunDetail.run', error);
  if (!run) return null;

  const [build, evidence, cases, defects, metrics, children] = await Promise.all([
    supabase.schema('projects').from('deliverables').select('title, version').eq('id', run.deliverable_id).maybeSingle(),
    supabase.schema('qa').from('test_run_evidence').select('id, kind, label, value, added_at, added_by').eq('run_id', runId).order('added_at', { ascending: true }),
    supabase.schema('qa').from('test_case_results').select('id, test_plan_item_id, status, notes, evidence_url').eq('test_run_id', runId).order('executed_at', { ascending: true }),
    supabase.schema('qa').from('defects').select('id, title, severity, status').eq('run_id', runId).order('created_at', { ascending: true }),
    supabase.schema('qa').from('metric_results').select('id, run_id, metric, value, unit, created_at').eq('run_id', runId).order('created_at', { ascending: false }),
    supabase.schema('qa').from('test_runs').select('id, suite, status, passed, failed, blocked, executed_at').eq('rerun_of', runId).order('executed_at', { ascending: true }),
  ]);
  for (const [label, r] of [['build', build], ['evidence', evidence], ['cases', cases], ['defects', defects], ['metrics', metrics], ['children', children]] as const) {
    if (r.error) unreadable(`readRunDetail.${label}`, r.error);
  }

  // The runs this one repeats, nearest first, stopping if the chain loops or leaves the project.
  const chain: RunChainEntry[] = [];
  const seen = new Set<string>([runId]);
  let parentId = run.rerun_of;
  while (parentId && !seen.has(parentId) && chain.length < 10) {
    seen.add(parentId);
    const { data: parent, error: parentError } = await supabase
      .schema('qa')
      .from('test_runs')
      .select('id, suite, status, passed, failed, blocked, executed_at, rerun_of')
      .eq('project_id', projectId)
      .eq('id', parentId)
      .maybeSingle();
    if (parentError) unreadable('readRunDetail.parent', parentError);
    if (!parent) break;
    chain.unshift({ id: parent.id, suite: parent.suite, status: parent.status, passed: parent.passed, failed: parent.failed, blocked: parent.blocked, executedAt: parent.executed_at, relation: 'earlier' });
    parentId = parent.rerun_of;
  }
  for (const c of children.data ?? []) {
    chain.push({ id: c.id, suite: c.suite, status: c.status, passed: c.passed, failed: c.failed, blocked: c.blocked, executedAt: c.executed_at, relation: 'later' });
  }

  const personIds = [...new Set([run.tester_id ?? run.executed_by, run.executed_by, ...(evidence.data ?? []).map((e) => e.added_by)].filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (personIds.length > 0) {
    const { data: members, error: membersError } = await supabase.schema('core').from('memberships').select('user_id, users:user_id(full_name, email)').in('user_id', personIds);
    if (membersError) unreadable('readRunDetail.members', membersError);
    for (const m of (members ?? []) as { user_id: string; users: { full_name: string | null; email: string } | null }[]) {
      names.set(m.user_id, m.users?.full_name ?? m.users?.email ?? 'Unknown');
    }
  }
  const testerId = run.tester_id ?? run.executed_by;

  return {
    id: run.id,
    suite: run.suite,
    status: run.status,
    deliverableId: run.deliverable_id,
    buildTitle: build.data?.title ?? null,
    buildVersion: build.data?.version ?? null,
    environment: run.environment,
    device: run.device,
    browser: run.browser,
    os: run.os,
    total: run.total,
    passed: run.passed,
    failed: run.failed,
    skipped: run.skipped,
    blocked: run.blocked,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    executedAt: run.executed_at,
    evidenceUrl: run.evidence_url,
    perfNotes: run.perf_notes,
    tester: run.executed_by_agent ? { kind: 'agent', key: run.executed_by_agent } : testerId ? { kind: 'person', name: names.get(testerId) ?? 'Unknown' } : null,
    recordedBy: run.executed_by ? (names.get(run.executed_by) ?? 'Unknown') : null,
    evidence: (evidence.data ?? []).map((e) => ({ id: e.id, kind: e.kind, label: e.label, value: e.value, addedAt: e.added_at, addedBy: e.added_by ? (names.get(e.added_by) ?? 'Unknown') : null })),
    cases: (cases.data ?? []).map((c) => ({ id: c.id, testPlanItemId: c.test_plan_item_id, status: c.status, notes: c.notes, evidenceUrl: c.evidence_url })),
    defects: (defects.data ?? []).map((d) => ({ id: d.id, title: d.title, severity: d.severity, status: d.status })),
    metrics: (metrics.data ?? []).map((m) => ({ id: m.id, runId: m.run_id, metric: m.metric, value: Number(m.value), unit: m.unit, recordedAt: m.created_at })) as MetricResultRow[],
    chain,
  };
}
