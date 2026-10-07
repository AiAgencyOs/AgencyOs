import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readLeadAgentTasks, readLeadAudit, readLeadObjections } from '@/modules/crm/p1s-lead-360-queries';
import { readLimitsInForce, readNegotiationQueue } from '@/modules/sales/p1s-negotiation-queries';
import { Badge, Card, CardHeader, EmptyState, humanize, type Tone } from '@/ui';

import { LimitsPanel } from '../../quotations/negotiation/limits-panel';

/**
 * The Lead 360 tabs that did not exist (A04, P1-BLUEPRINT-010): Negotiation, Tasks (agent work) and Audit. Each is a read of records that exist; each section
 * carries the id its tab scrolls to. They are server components rendered inside the lead page, so they cannot show a lead more than its own rows.
 */

const TASK_TONE: Record<string, Tone> = { queued: 'neutral', accepted: 'neutral', running: 'info', needs_input: 'warning', awaiting_approval: 'warning', rejected: 'danger', failed_retryable: 'warning', failed_permanent: 'danger', completed: 'success', cancelled: 'neutral' };
const money = (minor: number | null) => (minor === null ? 'n/a' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(minor / 100));

export async function LeadNegotiationSection({ leadId, opportunityId }: { leadId: string; opportunityId: string | null }) {
  const [objections, limits, queue, clock] = await Promise.all([readLeadObjections(leadId), readLimitsInForce(), opportunityId ? readNegotiationQueue() : Promise.resolve([]), agencyClock()]);
  const deal = opportunityId ? queue.find((q) => q.opportunityId === opportunityId) ?? null : null;
  return (
    <div id="negotiation" className="scroll-mt-24 flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Negotiation"
          description="What the client pushed back on, round by round, and the limits this deal is held to."
          actions={opportunityId ? <Link href={`/quotations/negotiation/${opportunityId}`} className="text-xs font-medium text-brand hover:underline">Open the negotiation record</Link> : undefined}
        />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {deal ? (
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              {deal.proposalVersion !== null ? <Badge dot>Version {deal.proposalVersion} · {(deal.proposalStatus ?? '').replace('_', ' ')}</Badge> : <Badge tone="neutral">no quotation yet</Badge>}
              {deal.totalMinor !== null ? <span>{money(deal.totalMinor)}</span> : null}
              {deal.atRoundCap ? <Badge tone="danger">at the round limit ({deal.roundCap})</Badge> : null}
              {deal.acceptanceUnclear ? <Badge tone="warning">acceptance unclear</Badge> : null}
              <span className="font-medium">Next: {deal.nextAction}</span>
            </div>
          ) : null}
          {objections.length === 0 ? (
            <EmptyState title="No objection recorded" description="The client has not pushed back on this lead." />
          ) : (
            <ol className="flex flex-col gap-2">
              {objections.map((o) => (
                <li key={o.id} className="rounded-lg border border-line p-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">Round {o.round}</span>
                    <Badge>{o.kind}</Badge>
                    {o.outcome ? <Badge tone="info">{o.outcome}</Badge> : <Badge tone="warning">open</Badge>}
                    <span className="text-xs text-muted">{clock.dateTime(o.at)}</span>
                  </div>
                  <p className="mt-1">“{o.concern}”</p>
                  {o.response ? <p className="mt-1 text-muted">We said: {o.response}</p> : null}
                  {o.nextAction ? <p className="mt-1 text-xs text-muted">Next: {o.nextAction}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </Card>
      <LimitsPanel limits={limits} />
    </div>
  );
}

export async function LeadAgentTasksSection({ leadId, opportunityId, proposalIds }: { leadId: string; opportunityId: string | null; proposalIds: readonly string[] }) {
  const [tasks, clock] = await Promise.all([readLeadAgentTasks({ leadId, opportunityId, proposalIds }), agencyClock()]);
  return (
    <Card id="tasks">
      <CardHeader title={`Agent tasks (${tasks.length})`} description="Work handed between agents about this lead, its deal or its quotations. A result received is not an acceptance: a task is done only when its completion is verified." actions={<Link href="/operations/task-board" className="text-xs font-medium text-brand hover:underline">Task board</Link>} />
      <div className="px-4 pb-4 sm:px-5">
        {tasks.length === 0 ? (
          <EmptyState title="No agent task yet" description="Nothing has been handed between agents for this lead." />
        ) : (
          <ul className="divide-y divide-line">
            {tasks.map((t) => (
              <li key={t.id} className="flex flex-col gap-1 py-2.5 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/operations/task-board/${t.id}`} className="font-medium hover:text-brand">{t.objective}</Link>
                  <Badge tone={TASK_TONE[t.status] ?? 'neutral'} dot>{t.status.replace('_', ' ')}</Badge>
                  {t.uncertain ? <Badge tone="danger">may have had an effect</Badge> : null}
                </div>
                <span className="text-xs text-muted">{t.fromAgent} → {t.toAgent} · {t.priority} priority · {clock.dateTime(t.createdAt)}{t.blocker ? ` · ${t.blocker}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export async function LeadAuditSection({ subjectIds }: { subjectIds: readonly string[] }) {
  const [rows, clock] = await Promise.all([readLeadAudit(subjectIds), agencyClock()]);
  return (
    <Card id="audit">
      <CardHeader title="Audit" description="Every recorded change to this lead, its deal, its quotations and its conversations, newest first. Visible to owners and ops admins." actions={<Link href="/audit" className="text-xs font-medium text-brand hover:underline">Full audit log</Link>} />
      <div className="px-4 pb-4 sm:px-5">
        {rows.length === 0 ? (
          <EmptyState title="Nothing audited yet" />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5 text-[13px]">
                <span>
                  <Badge mono>{r.action}</Badge> <span className="text-xs text-muted">{humanize(r.subjectType)} · {r.actorType}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {clock.dateTime(r.at)}
                  {r.correlationId ? <Link href={`/audit?correlation=${r.correlationId}`} className="underline-offset-2 hover:underline">chain</Link> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
