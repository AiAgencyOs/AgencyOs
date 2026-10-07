import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readHandoffPacket, readTaskHistory, readTaskRunEnvelopes } from '@/modules/orchestrator/p1o-coordination';
import { STATE_WORDS, isTaskState, nextDoorStep, type TaskState } from '@/modules/orchestrator/p1r-task-state';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, buttonClass } from '@/ui';

import { ResolveEscalationForm } from '../escalation-form';
import { TaskStepForm } from '../task-step-form';

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
  const history = await readTaskHistory(handoffId);
  const taskState: TaskState | null = isTaskState(history.at(-1)?.to) ? (history.at(-1)!.to as TaskState) : null;
  const nextStep = taskState && packet.paused !== true ? nextDoorStep(taskState) : null;
  const runs = await readTaskRunEnvelopes(String(packet.correlationId), String(packet.to));

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
        <CardHeader title="Where it is" description="Fourteen steps from created to closed, plus blocked, retrying, failed, expired, cancelled and escalated. The database moves a task along as its work moves; verifying and closing are an administrator's decision." />
        <CardBody>
          {taskState ? <p className="text-sm"><Badge dot>{STATE_WORDS[taskState]}</Badge></p> : <p className="text-sm text-muted">No history recorded.</p>}
          {admin && nextStep ? <div className="mt-3"><TaskStepForm handoffId={handoffId} toState={nextStep} label={STATE_WORDS[nextStep]} /></div> : null}
          {history.length > 0 ? (
            <ol className="mt-3 flex flex-col gap-1 text-xs text-muted">
              {history.map((m, i) => (
                <li key={i}>{new Date(m.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}: {m.from ? `${m.from.replace(/_/g, ' ')} to ` : 'born '}{m.to.replace(/_/g, ' ')} ({m.actorKind === 'person' ? 'a person' : 'the system'}, {m.source.replace('_', ' ')}){m.note ? `: ${m.note}` : ''}</li>
              ))}
            </ol>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Results of the runs" description="One envelope per run: status, validation, warnings, error class, attempt, provider and model, usage and cost, the next action and the policy it ran under." />
        <CardBody>
          {runs.envelopes.length === 0 ? <p className="text-sm text-muted">No agent run is recorded for this task.</p> : (
            <ul className="flex flex-col gap-3">
              {runs.envelopes.map((e) => (
                <li key={e.runId} className="rounded-lg border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><Badge dot>{e.status.replace(/_/g, ' ')}</Badge><Badge>{e.validationStatus.replace(/_/g, ' ')}</Badge><Badge>attempt {e.attempt}</Badge><Badge mono>{e.policyVersion ?? 'no policy stamp'}</Badge></div>
                  <p className="mt-1 text-xs text-muted">{e.agent} · {e.provider ?? 'no provider'} · {e.model ?? 'no model'} · {e.usage.inputTokens} in / {e.usage.outputTokens} out · cost {e.costMinor} minor units</p>
                  <p className="mt-1">Next: {e.nextAction.replace(/_/g, ' ')}{e.errorClass ? ` (error class: ${e.errorClass})` : ''}</p>
                  {e.warnings.length > 0 ? <ul className="mt-1 list-disc pl-5 text-xs text-muted">{e.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
                </li>
              ))}
            </ul>
          )}
          {runs.malformed > 0 ? <p className="mt-2 text-xs text-muted">{runs.malformed} run(s) answered in a shape that is not the agreed envelope and are not shown.</p> : null}
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
