import Link from 'next/link';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import type { DefectHistoryEntry, TestPlanVersion, TestRunDetail } from '@/modules/qa/dashboard-queries';
import type { Defect } from '@/modules/qa/types';
import { Badge, Card, CardHeader, FilterChips, humanize, Stat, StatGrid, statusTone, type Tone } from '@/ui';

import { PreviewButton } from '../../../preview-drawer';
import { DefectTriageForm, RaiseDefectForm, SettleDefectForm } from '../qa-panel';

/**
 * The QA tab's second half — SCR-045 to SCR-048, computed from the rows
 * `qa.test_runs`, `qa.test_plans` and `qa.defects` already hold:
 *
 *   · per-suite planned / executed / pass / fail figures. A run records
 *     item counts, so "executed" is the items a run reported and "planned"
 *     is the test-plan items in the matching category — the plan's
 *     `category` and the run's `suite` share their vocabulary
 *     (`functional`, `regression`, `performance`, `security`, …);
 *   · the regression pass rate, over `suite = 'regression'` runs only;
 *   · plan versions, one per scope baseline the project has frozen;
 *   · runs with the tester and the time on the row, and a "raise a defect
 *     from this run" door that pre-fills the build;
 *   · the defect register's four tiles — open by severity, awaiting a
 *     developer (`open`), awaiting retest (`fixed`), reopened (an audit
 *     `defect.open` on an UPDATE) — each a link to the list filtered to
 *     exactly that number (?defects=, ?severity=), and each defect's fix /
 *     retest trail from the audit log. Every bug row links to its own page
 *     (SCR-047, `qa/bugs/[defectId]`), which carries the evidence list and
 *     the linked build; the task (`task_id`) and the build (`build_id`) are
 *     drawn on the row too.
 */

const SEVERITY_TONE: Record<string, Tone> = { blocker: 'danger', major: 'warning', minor: 'info', trivial: 'neutral' };

const HISTORY_LABEL: Record<string, string> = {
  'defect.raised': 'raised',
  'defect.fixed': 'marked fixed',
  'defect.open': 'reopened — the fix did not hold',
  'defect.verified': 'verified by QA',
  'defect.wontfix': 'will not be fixed',
  'defect.updated': 'updated',
};

export function QaInsights({
  projectId,
  clock,
  runs,
  planItems,
  planVersions,
  defects,
  tasks,
  history,
  roster,
  builds,
  mayWrite,
  filter,
}: {
  projectId: string;
  clock: AgencyClock;
  runs: TestRunDetail[];
  /** The current plan's items — category per item — or none. */
  planItems: { category: string }[];
  planVersions: TestPlanVersion[];
  defects: (Defect & { assignee_id?: string | null; task_id?: string | null })[];
  /** SCR-047: the project's tasks, for the linked-task select and label. */
  tasks: { id: string; title: string; status: string }[];
  history: Map<string, DefectHistoryEntry[]>;
  roster: { userId: string; fullName: string }[];
  builds: { id: string; kind: string; version: number; title: string }[];
  mayWrite: boolean;
  /** SCR-047: the bug list's filter, from the page's search params. */
  filter?: { defects?: string; severity?: string };
}) {
  // ── per suite ──────────────────────────────────────────────────────────
  const suites = [...new Set([...runs.map((r) => r.suite), ...planItems.map((i) => i.category)])].sort();
  const bySuite = suites.map((suite) => {
    const suiteRuns = runs.filter((r) => r.suite === suite);
    return {
      suite,
      planned: planItems.filter((i) => i.category === suite).length,
      runs: suiteRuns.length,
      executed: suiteRuns.reduce((n, r) => n + r.total, 0),
      passed: suiteRuns.reduce((n, r) => n + r.passed, 0),
      failed: suiteRuns.reduce((n, r) => n + r.failed, 0),
    };
  });
  const regression = bySuite.find((s) => s.suite === 'regression');
  const regressionOutcomes = regression ? regression.passed + regression.failed : 0;
  const regressionRate = regressionOutcomes > 0 && regression ? Math.round((regression.passed / regressionOutcomes) * 100) : null;

  // ── defects ────────────────────────────────────────────────────────────
  const awaitingDeveloper = defects.filter((d) => d.status === 'open').length;
  const awaitingRetest = defects.filter((d) => d.status === 'fixed').length;
  const isReopened = (d: Defect) => (history.get(d.id) ?? []).some((h) => h.action === 'defect.open');
  const reopened = defects.filter(isReopened).length;
  const openBySeverity = (['blocker', 'major', 'minor', 'trivial'] as const).map((s) => ({ severity: s, count: defects.filter((d) => d.status === 'open' && d.severity === s).length }));

  // The list the tiles open: exactly the rows each tile counted.
  const defectsFilter = filter?.defects && ['open', 'fixed', 'reopened'].includes(filter.defects) ? filter.defects : undefined;
  const severityFilter = filter?.severity && ['blocker', 'major', 'minor', 'trivial'].includes(filter.severity) ? filter.severity : undefined;
  const visibleDefects = defects.filter((d) => {
    if (defectsFilter === 'open' && d.status !== 'open') return false;
    if (defectsFilter === 'fixed' && d.status !== 'fixed') return false;
    if (defectsFilter === 'reopened' && !isReopened(d)) return false;
    if (severityFilter && d.severity !== severityFilter) return false;
    return true;
  });
  const base = `/projects/${projectId}/qa`;
  const listHref = (q: { defects?: string; severity?: string }) => {
    const params = new URLSearchParams();
    if (q.defects) params.set('defects', q.defects);
    if (q.severity) params.set('severity', q.severity);
    const qs = params.toString();
    return `${base}${qs ? `?${qs}` : ''}#defects`;
  };
  const filtered = defectsFilter !== undefined || severityFilter !== undefined;

  const buildLabel = new Map(builds.map((b) => [b.id, `v${b.version} — ${b.title}`]));

  return (
    <>
      <StatGrid cols={5}>
        <Stat
          label="Regression pass rate"
          value={regressionRate === null ? '—' : `${regressionRate}%`}
          caption={regression && regression.runs > 0 ? `${regression.passed} of ${regressionOutcomes} results, ${regression.runs} run${regression.runs === 1 ? '' : 's'}` : 'no regression run recorded'}
          tone={regressionRate === null ? 'neutral' : regressionRate >= 90 ? 'success' : regressionRate >= 70 ? 'warning' : 'danger'}
        />
        <Stat
          label="Open by severity"
          value={String(awaitingDeveloper)}
          caption={openBySeverity.map((s) => `${s.count} ${s.severity}`).join(' · ')}
          tone={openBySeverity[0]!.count > 0 ? 'danger' : openBySeverity[1]!.count > 0 ? 'warning' : awaitingDeveloper > 0 ? 'info' : 'success'}
          href={listHref({ defects: 'open' })}
        />
        <Stat label="Awaiting a developer" value={String(awaitingDeveloper)} caption="open defects" tone={awaitingDeveloper > 0 ? 'warning' : 'success'} href={listHref({ defects: 'open' })} />
        <Stat label="Awaiting retest" value={String(awaitingRetest)} caption="fixed, not yet verified by QA" tone={awaitingRetest > 0 ? 'info' : 'success'} href={listHref({ defects: 'fixed' })} />
        <Stat label="Reopened" value={String(reopened)} caption="a fix that did not hold, at least once" tone={reopened > 0 ? 'danger' : 'success'} href={listHref({ defects: 'reopened' })} />
      </StatGrid>

      <Card>
        <CardHeader
          title="By suite"
          description="Planned is the test-plan items in the category; executed, passed and failed are what the recorded runs reported."
        />
        {bySuite.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing planned and no run recorded.</p>
        ) : (
          <div className="overflow-x-auto px-4 pb-4 sm:px-5">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-1 font-normal">Suite</th>
                  <th className="py-1 text-right font-normal">Planned</th>
                  <th className="py-1 text-right font-normal">Runs</th>
                  <th className="py-1 text-right font-normal">Executed</th>
                  <th className="py-1 text-right font-normal">Passed</th>
                  <th className="py-1 text-right font-normal">Failed</th>
                </tr>
              </thead>
              <tbody>
                {bySuite.map((s) => (
                  <tr key={s.suite} className="border-b border-line">
                    <td className="py-1">{humanize(s.suite)}</td>
                    <td className="py-1 text-right tabular">{s.planned}</td>
                    <td className="py-1 text-right tabular">{s.runs}</td>
                    <td className="py-1 text-right tabular">{s.executed}</td>
                    <td className="py-1 text-right tabular text-success">{s.passed}</td>
                    <td className={`py-1 text-right tabular ${s.failed > 0 ? 'text-danger' : ''}`}>{s.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {planVersions.length > 0 ? (
        <Card>
          <CardHeader title="Plan versions" description="One test plan per scope baseline. A superseded baseline's plan stays as history, the same way the baseline does." />
          <ul className="divide-y divide-line">
            {planVersions.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
                <span className="flex items-center gap-2">
                  <span className="font-medium">Baseline v{p.scopeVersion ?? '?'}</span>
                  {p.scopeStatus ? <Badge tone={statusTone(p.scopeStatus)}>{humanize(p.scopeStatus)}</Badge> : null}
                  <span className="text-muted">
                    {p.items} item{p.items === 1 ? '' : 's'}
                    {p.draftedByAgent ? ` · agent ${p.draftedByAgent}` : ' · drafted by a person'}
                  </span>
                </span>
                <span className="text-xs text-muted">{clock.dateTime(p.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Runs, with who and when" description="Every recorded run, newest first. A failed run is where a defect starts — raise one from the row and the build is filled in." />
        {runs.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No test run recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-col gap-1 px-4 py-2 text-[13px] sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={run.failed > 0 ? 'danger' : run.skipped > 0 ? 'warning' : 'success'}>{run.suite}</Badge>
                    <span className="text-muted">{buildLabel.get(run.deliverableId) ?? 'build'}</span>
                    {run.environment ? <Badge tone="neutral">{run.environment}</Badge> : null}
                    <span className="tabular">
                      {run.passed}/{run.total} passed
                      {run.failed > 0 ? `, ${run.failed} failed` : ''}
                      {run.skipped > 0 ? `, ${run.skipped} skipped` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    <span>
                      {run.tester
                        ? run.tester.kind === 'person'
                          ? run.tester.name
                          : `agent ${run.tester.key}`
                        : 'tester not recorded'}
                    </span>
                    <span>· executed {clock.dateTime(run.executedAt)}</span>
                    {run.evidenceUrl ? (
                      <a href={run.evidenceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        evidence
                      </a>
                    ) : null}
                    <Link href={`/projects/${projectId}/qa/runs/${run.id}`} className="font-medium text-brand hover:underline">Open run</Link>
                  </span>
                </div>
                {mayWrite && run.failed > 0 ? (
                  <details className="rounded-md border border-dashed border-line px-3 py-1.5">
                    <summary className="cursor-pointer text-xs text-muted">Raise a defect from this run</summary>
                    <div className="pt-2">
                      <RaiseDefectForm projectId={projectId} deliverables={builds} defaultDeliverableId={run.deliverableId} />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div id="defects">
          <CardHeader
            title={filtered ? `Defects (${visibleDefects.length} of ${defects.length})` : `Defects (${defects.length})`}
            description="Who has it, how bad it is, and what has happened to it. A developer marks it fixed; QA verifies or reopens. Open a bug for its page — reproduction, evidence, linked task and build, and the full history."
            actions={
              <a href={`/api/projects/${projectId}/qa/evidence`} className="text-xs underline underline-offset-2">
                Evidence summary (CSV)
              </a>
            }
          />
        </div>
        <div className="px-4 pb-3 sm:px-5">
          <FilterChips
            options={[
              { key: 'all', label: 'All', href: listHref({ severity: severityFilter }), active: defectsFilter === undefined },
              { key: 'open', label: `Open (${awaitingDeveloper})`, href: listHref({ defects: 'open', severity: severityFilter }), active: defectsFilter === 'open' },
              { key: 'fixed', label: `Awaiting retest (${awaitingRetest})`, href: listHref({ defects: 'fixed', severity: severityFilter }), active: defectsFilter === 'fixed' },
              { key: 'reopened', label: `Reopened (${reopened})`, href: listHref({ defects: 'reopened', severity: severityFilter }), active: defectsFilter === 'reopened' },
              ...openBySeverity.map((s) => ({ key: s.severity, label: humanize(s.severity), href: listHref({ defects: defectsFilter, severity: severityFilter === s.severity ? undefined : s.severity }), active: severityFilter === s.severity })),
            ]}
          />
        </div>
        {defects.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No defect has been raised.</p>
        ) : visibleDefects.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">
            No defect matches this filter.{' '}
            <Link href={listHref({})} className="underline underline-offset-2">
              Show all
            </Link>
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {visibleDefects.map((d) => {
              const trail = history.get(d.id) ?? [];
              const assignee = roster.find((m) => m.userId === d.assignee_id);
              return (
                <li key={d.id} className="flex flex-col gap-1 px-4 py-3 text-[13px] sm:px-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={SEVERITY_TONE[d.severity] ?? 'neutral'}>{d.severity}</Badge>
                      <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge>
                      <Link href={`/projects/${projectId}/qa/bugs/${d.id}`} className="font-medium hover:underline">
                        {d.title}
                      </Link>
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted">
                      {assignee ? assignee.fullName : 'unassigned'} · raised {clock.date(d.created_at)}
                      <PreviewButton group="Bug" id={d.id} />
                    </span>
                  </div>
                  {d.task_id || d.build_id ? (
                    <p className="flex flex-wrap gap-x-3 text-xs text-muted">
                      {d.task_id ? (
                        <span>
                          Task:{' '}
                          <Link href={`/projects/${projectId}/development/tasks/${d.task_id}`} className="underline underline-offset-2 hover:text-foreground">
                            {tasks.find((t) => t.id === d.task_id)?.title ?? 'open task'}
                          </Link>
                        </span>
                      ) : null}
                      {d.build_id ? (
                        <span>
                          Build:{' '}
                          <Link href={`/projects/${projectId}/builds`} className="underline underline-offset-2 hover:text-foreground">
                            {buildLabel.get(d.build_id) ?? 'build'}
                          </Link>
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  {trail.length > 0 ? (
                    <ol className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                      {trail.map((h, i) => (
                        <li key={`${h.createdAt}-${i}`}>
                          {HISTORY_LABEL[h.action] ?? h.action.replace('defect.', '')} · {clock.dateTime(h.createdAt)}
                          {h.actorType ? ` · ${h.actorType}` : ''}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {mayWrite ? <DefectTriageForm projectId={projectId} defect={d} roster={roster} tasks={tasks} /> : null}
                  {mayWrite ? <SettleDefectForm projectId={projectId} defect={d} /> : null}
                </li>
              );
            })}
          </ul>
        )}
        <p className="px-4 pb-4 text-xs text-muted sm:px-5">
          The register is also on the{' '}
          <Link href={`/projects/${projectId}`} className="underline underline-offset-2">
            project overview
          </Link>
          . A defect names the task it is about at triage (SCR-047); the task&apos;s own page lists its defects.
        </p>
      </Card>
    </>
  );
}
