import type { Metadata } from 'next';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { Badge, Card, EmptyState, IconApprovals, PageHeader } from '@/ui';
import { listApprovalPolicies, listPendingApprovals } from '@/modules/approvals/queries';
import { isOverdue, type ApprovalState } from '@/modules/approvals/schema';
import type { ApprovalPolicyRow } from '@/modules/approvals/types';

import { ApprovalDecisionForm } from './approval-decision-form';

export const metadata: Metadata = { title: 'Approvals' };

const MONEY = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** What a subject type is called on screen. Vocabulary, not logic. */
const SUBJECT_LABEL: Record<string, string> = {
  proposal: 'Proposal',
  deliverable: 'Deliverable',
  invoice: 'Invoice',
  refund: 'Refund',
  scope_change: 'Scope change',
  prototype: 'Prototype',
  agent_action: 'Agent action',
  ticket_plan: 'Ticket plan',
};

/**
 * The approval centre — gap G-044, directive §27.
 *
 * Everything waiting on a human, in one place, soonest deadline first. Before
 * this page the engine held decisions nobody could see, which is most of the
 * distance between a schema and a working gate.
 *
 * **No capability check guards this route, and that is deliberate.** Every
 * other internal page re-checks a capability because its rows are readable by
 * roles that should not see that screen. Here the queue *is* the capability:
 * `approval_requests_select` admits internal roles of the caller's own
 * organization and nothing else, so a contractor typing the URL gets their own
 * organization's queue and can settle none of it — `decide_approval` checks the
 * required role under a lock. There is no narrower capability to check that
 * would not be a worse copy of the rule the row already carries.
 *
 * The reads refuse rather than render empty (G-054): "nothing needs your
 * attention" is the single most expensive lie this application could tell.
 */
export default async function ApprovalsPage() {
  await requireInternal('/approvals');
  const clock = await agencyClock();

  const [pending, policies] = await Promise.all([listPendingApprovals(), listApprovalPolicies()]);
  const late = pending.filter((request) =>
    isOverdue({ state: request.state as ApprovalState, slaDueAt: request.sla_due_at }),
  ).length;

  // Group the active policies by subject type so each subject reads as a ladder
  // — the shape the resolver walks (highest threshold at or below the amount).
  // listApprovalPolicies already orders by subject then ascending amount.
  const policyGroups = new Map<string, ApprovalPolicyRow[]>();
  for (const policy of policies) {
    const group = policyGroups.get(policy.subject_type) ?? [];
    group.push(policy);
    policyGroups.set(policy.subject_type, group);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Approvals"
        description={
          pending.length === 0
            ? 'Nothing is waiting on a decision.'
            : `${pending.length} waiting${late > 0 ? ` · ${late} past its deadline` : ''}.`
        }
        meta={
          pending.length > 0 ? (
            <>
              <Badge tone="info" dot>
                {pending.length} pending
              </Badge>
              {late > 0 ? (
                <Badge tone="danger" dot>
                  {late} overdue
                </Badge>
              ) : null}
            </>
          ) : null
        }
      />

      {pending.length === 0 ? (
        <EmptyState
          icon={<IconApprovals size={22} />}
          title="Nothing is waiting on a decision"
          description="When something needs a decision — a deliverable, an invoice, a refund — it appears here."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {pending.map((request) => {
            const overdue = isOverdue({
              state: request.state as ApprovalState,
              slaDueAt: request.sla_due_at,
            });

            return (
              <li key={request.id}>
                <Card className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {SUBJECT_LABEL[request.subject_type] ?? request.subject_type}
                      </span>

                      {request.audience === 'client' ? <Badge tone="info">client</Badge> : null}

                      {request.amount_minor !== null ? (
                        <span className="text-xs text-muted">
                          {MONEY.format(request.amount_minor / 100)}
                        </span>
                      ) : null}
                    </div>

                    <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
                      {request.summary ?? 'No summary was given when this was raised.'}
                    </p>

                    <p className="text-xs text-muted">
                      Needs {request.required_role.replace('_', ' ')} · raised by{' '}
                      {request.requested_by_type === 'system'
                        ? 'the system'
                        : request.requested_by_type}{' '}
                      · {clock.dateTime(request.created_at)}
                    </p>
                  </div>

                  <Badge tone={overdue ? 'danger' : 'neutral'} dot={overdue}>
                    {overdue ? 'Overdue since ' : 'Due '}
                    {clock.dateTime(request.sla_due_at)}
                  </Badge>
                </div>

                <div className="mt-3 border-t border-line pt-3">
                  <ApprovalDecisionForm
                    requestId={request.id}
                    audience={request.audience}
                    subjectType={request.subject_type}
                  />
                </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {/*
        ADM-08c: an unanswered request expires and escalates to the owner. The
        cron tick does that now (G-096), so this text says what happens rather
        than apologising for what does not.
      */}
      {late > 0 ? (
        <p className="text-xs text-muted">
          Anything past its deadline is expired on the next cron tick and raised again with the owner.
          Nothing is ever approved by silence.
        </p>
      ) : null}

      {/*
        The rules that decide what lands in the queue above and who must answer
        it — read-only. Every request here was routed by one of these: the
        resolver takes the highest threshold at or below the amount, so a
        subject's policies read as a ladder (any amount → ops_admin, ≥ ₹5L →
        owner). This SHOWS them so an operator can see why a request needs the
        role it does; it does NOT edit them. Changing who may approve what is an
        authority change, owner-only and audited, made deliberately in the
        database — not a screen a queue view should hand out. `unreadable()` in
        the query means a failed read refuses rather than implying no rules.
      */}
      {policies.length > 0 ? (
        <section className="flex flex-col gap-3 border-t border-line pt-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-[13px] font-semibold tracking-tight">Policies in force</h2>
            <p className="text-xs text-muted">
              What needs a decision, and from whom. Read-only — these are configured in the database
              and changing one is an owner-only, audited authority change.
            </p>
          </div>

          <ul className="flex flex-col gap-3">
            {[...policyGroups.entries()].map(([subjectType, group]) => (
              <li
                key={subjectType}
                className="rounded-lg border border-line bg-surface px-4 py-3"
              >
                <div className="mb-2 text-sm font-medium">
                  {SUBJECT_LABEL[subjectType] ?? subjectType}
                </div>
                <ul className="flex flex-col gap-1.5">
                  {group.map((policy) => (
                    <li
                      key={policy.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm"
                    >
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="tabular">
                          {policy.min_amount_minor > 0
                            ? `≥ ${MONEY.format(policy.min_amount_minor / 100)}`
                            : 'Any amount'}
                        </span>
                        <span className="text-muted">→ {policy.required_role.replace(/_/g, ' ')}</span>
                        {policy.audience === 'client' ? (
                          <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-muted">
                            client
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted">
                        {policy.sla_hours}h to answer
                        {policy.note ? ` · ${policy.note}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
