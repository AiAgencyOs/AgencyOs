import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readHandoffPacket } from '@/modules/orchestrator/p1o-coordination';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, buttonClass } from '@/ui';

import { ResolveEscalationForm } from '../escalation-form';

export const metadata: Metadata = { title: 'Task detail' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Dep = { id: string; status: string; to: string };
type Esc = { id: string; cause: string; state: string; recommendation: string; attemptedRoutes: unknown[]; failures: Array<{ attempt?: number; summary?: string }>; raisedAt: string };

/**
 * Admin Panel A17, Task Detail (P1-COORD-025, P1-HANDOFF-005/006/008). The task's envelope as the database holds it: who handed what to whom, the acceptance
 * criteria, the policy and approval references, the prerequisites and where each stands, the failure the last attempt left behind, every escalation with the
 * routes tried and a recommendation, and the verdict that closed it. Read-only apart from resolving an escalation (an administrator's decision, with a note).
 */
export default async function TaskDetailPage({ params }: { params: Promise<{ handoffId: string }> }) {
  const { handoffId } = await params;
  if (!UUID.test(handoffId)) notFound();
  const context = await requireInternal(`/operations/task-board/${handoffId}`);
  if (!can(context, 'audit.read')) return <PermissionDenied />;
  const packet = await readHandoffPacket(handoffId);
  if (!packet) notFound();

  const criteria = Array.isArray(packet.acceptanceCriteria) ? (packet.acceptanceCriteria as string[]) : [];
  const deps = (Array.isArray(packet.dependencies) ? packet.dependencies : []) as Dep[];
  const escalations = (Array.isArray(packet.escalations) ? packet.escalations : []) as Esc[];
  const admin = can(context, 'agent.configure');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={String(packet.objective)}
        description={`${String(packet.from)} handed this to ${String(packet.to)}.`}
        meta={<><Badge dot>{String(packet.status).replace('_', ' ')}</Badge><Badge>{String(packet.priority)} priority</Badge>{packet.paused === true ? <Badge tone="warning">paused: {String(packet.pauseReason)}</Badge> : null}{packet.sideEffectUncertain === true ? <Badge tone="danger">last attempt may have had an effect</Badge> : null}</>}
        actions={<Link href="/operations/task-board" className={buttonClass('secondary', 'sm')}>Back to the board</Link>}
      />

      <Card>
        <CardHeader title="Acceptance criteria" description="What must be true for this to count as done. Completion needs a verified verdict that answers these." />
        <CardBody>
          {criteria.length === 0 ? <p className="text-sm text-muted">None were recorded when this task was created (it predates the contract).</p> : <ul className="list-disc pl-5 text-sm">{criteria.map((c, i) => <li key={i}>{c}</li>)}</ul>}
          {packet.blocker ? <p className="mt-3 text-sm"><span className="font-medium">Blocker:</span> {String(packet.blocker)}</p> : null}
          {packet.previousFailure ? <p className="mt-2 text-sm"><span className="font-medium">Last failure (attempt {String(packet.retryCount)}):</span> {String(packet.previousFailure)}</p> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="References" />
        <CardBody>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">Idempotency key</dt><dd className="font-mono text-xs">{String(packet.idempotencyKey ?? 'none')}</dd></div>
            <div><dt className="text-muted">Correlation</dt><dd className="font-mono text-xs">{String(packet.correlationId)}</dd></div>
            <div><dt className="text-muted">Policy decision</dt><dd>{String(packet.policyDecisionRef ?? 'none')} {packet.policyVersion ? <Badge mono>{String(packet.policyVersion)}</Badge> : null}</dd></div>
            <div><dt className="text-muted">Approval request</dt><dd className="font-mono text-xs">{String(packet.approvalRequestId ?? 'none')}</dd></div>
            <div><dt className="text-muted">Bound quotation</dt><dd className="font-mono text-xs">{String(packet.boundProposalId ?? 'none')}</dd></div>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Prerequisites" description="Nothing is dispatched before these have completed." />
        <CardBody>
          {deps.length === 0 ? <p className="text-sm text-muted">None.</p> : (
            <ul className="flex flex-col gap-1 text-sm">{deps.map((d) => <li key={d.id}><Link href={`/operations/task-board/${d.id}`} className="underline">{d.to}</Link> <Badge dot tone={d.status === 'completed' ? 'success' : 'warning'}>{d.status.replace('_', ' ')}</Badge></li>)}</ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Escalations" description="What was tried, what failed, and what is recommended." />
        <CardBody>
          {escalations.length === 0 ? <EmptyState title="Never escalated" /> : (
            <ul className="flex flex-col gap-3">
              {escalations.map((e) => (
                <li key={e.id} className="rounded-lg border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><Badge dot tone={e.state === 'open' ? 'danger' : 'success'}>{e.cause.replace(/_/g, ' ')}</Badge><span className="text-xs text-muted">{e.state} · raised {new Date(e.raisedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span></div>
                  <p className="mt-1">{e.recommendation}</p>
                  {e.attemptedRoutes.length > 0 ? <p className="mt-1 text-xs text-muted">Routes tried: {JSON.stringify(e.attemptedRoutes)}</p> : null}
                  {e.failures.length > 0 ? <p className="mt-1 text-xs text-muted">Failures: {e.failures.map((f) => `attempt ${f.attempt ?? '?'}: ${f.summary ?? ''}`).join('; ')}</p> : null}
                  {admin && e.state === 'open' ? <div className="mt-2"><ResolveEscalationForm escalationId={e.id} /></div> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {packet.verification ? (
        <Card>
          <CardHeader title="Verdict" description="Signed by the declared verifier; a producer never verifies its own work." />
          <CardBody><pre className="overflow-x-auto text-xs">{JSON.stringify(packet.verification, null, 2)}</pre></CardBody>
        </Card>
      ) : null}
    </div>
  );
}
