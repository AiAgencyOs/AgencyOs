import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { listPendingApprovals } from '@/modules/approvals/queries';
import { isOverdue, type ApprovalState } from '@/modules/approvals/schema';

import { ApprovalDecisionForm } from './approval-decision-form';

export const metadata: Metadata = { title: 'Approvals · AgencyOS' };

const WHEN = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

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

  const pending = await listPendingApprovals();
  const late = pending.filter((request) =>
    isOverdue({ state: request.state as ApprovalState, slaDueAt: request.sla_due_at }),
  ).length;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted">
          {pending.length === 0
            ? 'Nothing is waiting on a decision.'
            : `${pending.length} waiting${late > 0 ? ` · ${late} past its deadline` : ''}.`}
        </p>
      </div>

      {pending.length === 0 ? (
        <p className="rounded-lg border border-black/10 px-4 py-8 text-center text-sm text-muted dark:border-white/15">
          When something needs a decision — a deliverable, an invoice, a refund — it appears here.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {pending.map((request) => {
            const overdue = isOverdue({
              state: request.state as ApprovalState,
              slaDueAt: request.sla_due_at,
            });

            return (
              <li
                key={request.id}
                className="rounded-lg border border-black/10 px-4 py-3 dark:border-white/15"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {SUBJECT_LABEL[request.subject_type] ?? request.subject_type}
                      </span>

                      {request.audience === 'client' ? (
                        <span className="rounded border border-black/15 px-1.5 py-0.5 text-xs text-muted dark:border-white/20">
                          client
                        </span>
                      ) : null}

                      {request.amount_minor !== null ? (
                        <span className="text-xs text-muted">
                          {MONEY.format(request.amount_minor / 100)}
                        </span>
                      ) : null}
                    </div>

                    <p className="text-sm text-muted">
                      {request.summary ?? 'No summary was given when this was raised.'}
                    </p>

                    <p className="text-xs text-muted">
                      Needs {request.required_role.replace('_', ' ')} · raised by{' '}
                      {request.requested_by_type === 'system'
                        ? 'the system'
                        : request.requested_by_type}{' '}
                      · {WHEN.format(new Date(request.created_at))}
                    </p>
                  </div>

                  <span
                    className={`whitespace-nowrap text-xs ${
                      overdue ? 'text-red-600 dark:text-red-400' : 'text-muted'
                    }`}
                  >
                    {overdue ? 'Overdue since ' : 'Due '}
                    {WHEN.format(new Date(request.sla_due_at))}
                  </span>
                </div>

                <ApprovalDecisionForm requestId={request.id} audience={request.audience} />
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
    </div>
  );
}
