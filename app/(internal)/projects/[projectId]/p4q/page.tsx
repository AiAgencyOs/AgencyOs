import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  markShareDeliveryAction,
  recordClientReviewShareAction,
  resolveEscalationAction,
  resolveQaBlockerAction,
  verifyRetestedDefectAction,
} from '@/modules/p4q/actions';
import {
  readClientReviewShares,
  readDefectsAwaitingVerification,
  readPrototypeAdminHandoff,
  readUiVersionsForShare,
  readValidationMatrix,
  readEscalations,
  readFailureQueue,
  readM2Overview,
  readPhaseFourTrace,
  readPrototypeQaOverview,
  readReminderOverview,
  readRevisionRecords,
} from '@/modules/p4q/queries';
import { getProject } from '@/modules/projects/queries';
import { Badge, Card, EmptyState, humanize, PermissionDenied } from '@/ui';

export const metadata: Metadata = { title: 'Phase 4 records' };

function tone(state: string): 'success' | 'danger' | 'warning' | 'info' {
  if (['qa_pass', 'delivered', 'verified', 'resolved', 'sent'].includes(state)) return 'success';
  if (['qa_changes_required', 'failed', 'blocked_external', 'invalid_intake', 'escalated', 'open'].includes(state)) return 'danger';
  if (['unknown', 'pending', 'not_run'].includes(state)) return 'warning';
  return 'info';
}

function money(minor: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(minor / 100);
}

/**
 * Phase 4 control room: what Prototype QA recorded per build (state, owner, blocker, why), the revision records, the exact client shares and what is known of their
 * delivery, escalations a person must decide, the failure queue, the M2 line and reminder schedule, and the one joined trace of every hop. All reads come from the
 * database read functions of migrations 20261126*, which return nothing to a caller who may not read them.
 */
export default async function PhaseFourRecordsPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { projectId } = await params;
  const { notice } = await searchParams;
  const context = await requireInternal(`/projects/${projectId}/p4q`);
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const project = await getProject(projectId);
  if (!project) notFound();

  const uiShares = await readUiVersionsForShare(projectId);
  const [qa, awaiting, revisions, shares, escalations, failures, m2, reminders, trace] = await Promise.all([
    readPrototypeQaOverview(projectId),
    readDefectsAwaitingVerification(projectId),
    readRevisionRecords(projectId),
    readClientReviewShares(projectId),
    readEscalations(projectId),
    readFailureQueue(projectId),
    readM2Overview(projectId),
    readReminderOverview(projectId),
    readPhaseFourTrace(projectId),
  ]);

  const latest = qa.find((r) => r.latest_run_id) ?? null;
  const handoff = latest ? await readPrototypeAdminHandoff(latest.artifact_id) : null;
  const matrix = latest?.latest_run_id ? await readValidationMatrix(latest.latest_run_id) : [];
  const list = (key: string): Array<Record<string, unknown>> => (Array.isArray(handoff?.[key]) ? (handoff?.[key] as Array<Record<string, unknown>>) : []);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Phase 4 records: {project.name}</h1>
      {notice ? <p className="rounded border border-line p-2 text-sm">{notice}</p> : null}

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Prototype QA by build</h2>
        {qa.length === 0 ? (
          <EmptyState title="No prototype build yet" />
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <thead><tr><th>UI version</th><th>QA state</th><th>Next move</th><th>Failed checks</th><th>Why</th></tr></thead>
            <tbody>
              {qa.map((row) => (
                <tr key={row.artifact_id}>
                  <td>v{row.ui_version}</td>
                  <td><Badge tone={tone(row.qa_state)} dot>{humanize(row.qa_state)}</Badge></td>
                  <td>{humanize(row.owner)}</td>
                  <td>{row.checks_failed ?? '-'}</td>
                  <td className="text-muted">
                    {row.blocker ?? row.why ?? ''}
                    {row.blocker_id ? (
                      <form action={resolveQaBlockerAction} className="mt-1 flex gap-1">
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="blockerId" value={row.blocker_id} />
                        <input name="note" required minLength={5} placeholder="What was done to unblock it" className="min-w-56 rounded border border-line p-1" />
                        <button type="submit" className="rounded border border-line px-2">Resolve blocker</button>
                      </form>
                    ) : null}
                    {row.qa_state === 'qa_pass' ? (
                      <form action={recordClientReviewShareAction} className="mt-1 flex gap-1">
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="kind" value="prototype_build" />
                        <input type="hidden" name="targetId" value={row.deliverable_id} />
                        <select name="channel" aria-label="Channel the client was shown it on" className="rounded border border-line p-1" defaultValue="portal">
                          {['whatsapp', 'email', 'portal', 'internal_group', 'manual'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
                        </select>
                        <button type="submit" className="rounded border border-line px-2">Record share</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {handoff ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Admin handoff package for the latest QA run</h2>
          <p className="mt-1 text-sm text-muted">
            Open defects: {Object.entries((handoff.openDefectsBySeverity ?? {}) as Record<string, number>).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}. Regressions: {list('regressions').length}. Open blockers: {list('openBlockers').length}.
          </p>
          {list('limitations').length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-sm">
              {list('limitations').map((l, i) => <li key={i}>Known limitation: {String(l.statement)} {l.qaAccuracy ? `(QA: ${humanize(String(l.qaAccuracy))})` : ''}</li>)}
            </ul>
          ) : null}
          {list('fixAndRetest').length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-sm">
              {list('fixAndRetest').map((f, i) => <li key={i}>Fix for {String(f.checkKey)}: retest {f.retestResult ? humanize(String(f.retestResult)) : 'not run yet'}</li>)}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {matrix.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Validation matrix</h2>
          <table className="mt-2 w-full text-left text-xs">
            <thead><tr><th>Category</th><th>Target</th><th>Result</th><th>Severity</th><th>What was found</th></tr></thead>
            <tbody>
              {matrix.map((c) => (
                <tr key={c.check_key}>
                  <td>{humanize(c.category)}</td>
                  <td>{c.target}</td>
                  <td><Badge tone={c.result === 'pass' ? 'success' : c.result === 'fail' ? 'danger' : 'warning'} dot>{humanize(c.result)}</Badge></td>
                  <td>{c.severity}</td>
                  <td className="text-muted">{c.actual}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {uiShares.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Record a UI version as shown to the client</h2>
          {uiShares.map((v) => (
            <form key={v.id} action={recordClientReviewShareAction} className="mt-1 flex items-center gap-2 text-sm">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="kind" value="ui_version" />
              <input type="hidden" name="targetId" value={v.id} />
              <span>Version {v.version} ({humanize(v.status)})</span>
              <select name="channel" aria-label="Channel the client was shown it on" className="rounded border border-line p-1" defaultValue="whatsapp">
                {['whatsapp', 'email', 'portal', 'internal_group', 'manual'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
              </select>
              <button type="submit" className="rounded border border-line px-2">Record share</button>
            </form>
          ))}
        </Card>
      ) : null}

      {awaiting.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Fixes waiting for a person to verify</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {awaiting.map((a) => (
              <li key={a.defect_id} className="flex flex-wrap items-center gap-2">
                <span>{a.title}</span>
                <form action={verifyRetestedDefectAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="defectId" value={a.defect_id} />
                  <button type="submit" className="rounded border border-line px-2">Verify</button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Escalations</h2>
        {escalations.length === 0 ? (
          <p className="mt-2 text-sm text-muted">None.</p>
        ) : (
          <ul className="mt-2 space-y-3 text-sm">
            {escalations.map((e) => (
              <li key={e.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={tone(e.state)} dot>{humanize(e.cause)}</Badge>
                  <span className="text-muted">owner {humanize(e.owner)}{e.raised_by_agent ? `, raised by ${humanize(e.raised_by_agent)}` : ''}</span>
                </div>
                <p>{e.reason}</p>
                {e.state === 'open' ? (
                  <form action={resolveEscalationAction} className="mt-1 flex flex-wrap gap-2">
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="escalationId" value={e.id} />
                    <select name="decision" aria-label="Decision" className="rounded border border-line p-1" defaultValue="continue">
                      {['continue', 'change_request', 'stop', 'reassign', 'fix_and_retry', 'dismissed'].map((d) => <option key={d} value={d}>{humanize(d)}</option>)}
                    </select>
                    <input name="note" required minLength={5} placeholder="Why" className="min-w-64 rounded border border-line p-1" />
                    <button type="submit" className="rounded border border-line px-2">Resolve</button>
                  </form>
                ) : (
                  <p className="text-muted">{humanize(e.state)}{e.decision ? `: ${humanize(e.decision)}` : ''}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">What the client was shown</h2>
        {shares.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing recorded as shared yet.</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {shares.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <span>{humanize(s.kind)} via {humanize(s.channel)}</span>
                <Badge tone={tone(s.delivery_state)} dot>{humanize(s.delivery_state)}</Badge>
                {s.retry_count > 0 ? <span className="text-muted">retried {s.retry_count}x</span> : null}
                <form action={markShareDeliveryAction} className="flex gap-1">
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="shareId" value={s.id} />
                  <select name="state" aria-label="Delivery state" className="rounded border border-line p-1" defaultValue="sent">
                    {['pending', 'sent', 'delivered', 'failed', 'unknown'].map((d) => <option key={d} value={d}>{humanize(d)}</option>)}
                  </select>
                  <input name="evidence" placeholder="Evidence (message id, provider answer)" className="min-w-56 rounded border border-line p-1" />
                  <button type="submit" className="rounded border border-line px-2">Save</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Revision records</h2>
        {revisions.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No revision yet.</p>
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <thead><tr><th>What</th><th>From</th><th>To</th><th>Origin</th><th>Changed screens</th><th>Classification</th></tr></thead>
            <tbody>
              {revisions.map((r, i) => (
                <tr key={`${r.artifact_kind}-${i}`}>
                  <td>{humanize(r.artifact_kind)}</td>
                  <td>{r.from_version ?? ''}</td>
                  <td>{r.to_version ?? ''}</td>
                  <td>{humanize(r.origin.toLowerCase())}</td>
                  <td>{r.affected_screens.join(', ')}</td>
                  <td>{r.classification ? humanize(r.classification.toLowerCase()) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {failures.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Failure queue</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {failures.map((f) => (
              <li key={f.envelope_id}>
                {humanize(f.task_type)} ({humanize(f.agent_key)}): {humanize(f.last_class)}, attempt {f.attempts} of {f.retry_budget}, {humanize(f.status)}. {f.last_detail}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {m2 ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">M2 payment</h2>
          <p className="mt-1 text-sm">
            {m2.payment_percent}% of the project, {money(m2.amount_minor)}; trigger {humanize(m2.trigger_state)}; invoice {m2.invoice_status ? humanize(m2.invoice_status) : 'not created'}; balance {money(m2.balance_minor)}; Phase 5 gate {humanize(m2.gate)}; baseline {m2.baseline}.
          </p>
          {reminders.length > 0 ? (
            <ul className="mt-2 text-sm text-muted">
              {reminders.map((r) => <li key={`${r.invoice_number}-${r.stage}`}>{r.invoice_number}: {humanize(r.stage)} reminder {humanize(r.state)} ({r.attempts} attempt(s)){r.note ? `: ${r.note}` : ''}</li>)}
            </ul>
          ) : null}
        </Card>
      ) : null}

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Trace</h2>
        {trace.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No hop recorded yet.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-xs">
            {trace.map((t) => <li key={`${t.source}-${t.ref_id}`}>{new Date(t.at).toISOString()} {humanize(t.source)} {humanize(t.kind)}: {t.summary}</li>)}
          </ul>
        )}
      </Card>
    </div>
  );
}
