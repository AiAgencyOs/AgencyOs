import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { getApproval } from '@/modules/approvals/queries';
import { isOverdue, type ApprovalState } from '@/modules/approvals/schema';
import { Badge, Card, DetailList, DetailRow, PageHeader, humanize } from '@/ui';

import { ApprovalDecisionForm } from '../approval-decision-form';

export const metadata: Metadata = { title: 'Approval' };

const MONEY = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

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

const STATE_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  changes_requested: 'danger',
  expired: 'neutral',
  cancelled: 'neutral',
};

/**
 * SCR-044 (approvals module)'s one request, on its own page — `getApproval`
 * had a real reader and no route anywhere. The pending queue (`/approvals`)
 * already renders everything needed to decide a request, and a project's own
 * page already shows its subject-scoped history (`listApprovalsForSubject`)
 * — this fills the one gap neither covers: a permalink to a single request
 * by its own id, decided or not, for whatever else in the product (audit
 * log, a notification, a message) ends up wanting to point at one directly.
 *
 * No capability check, same reasoning `/approvals`' own page gives:
 * `approval_requests_select` already scopes this to the caller's own
 * organization, and there is no narrower capability that would not be a
 * worse copy of the rule the row already carries.
 */
export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;

  await requireInternal(`/approvals/${requestId}`);
  const clock = await agencyClock();

  const request = await getApproval(requestId);
  if (!request) notFound();

  const overdue = isOverdue({ state: request.state as ApprovalState, slaDueAt: request.sla_due_at });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={SUBJECT_LABEL[request.subject_type] ?? request.subject_type}
        description={request.summary ?? 'No summary was given when this was raised.'}
        meta={
          <>
            <Badge tone={STATE_TONE[request.state] ?? 'neutral'} dot>
              {humanize(request.state)}
            </Badge>
            {request.state === 'pending' && overdue ? (
              <Badge tone="danger" dot>
                overdue
              </Badge>
            ) : null}
          </>
        }
      />

      <p className="text-xs text-muted">
        <Link href="/approvals" className="underline underline-offset-2 hover:text-ink">
          Back to the queue
        </Link>
      </p>

      <Card className="p-4 sm:p-5">
        <DetailList>
          <DetailRow label="Needs" value={humanize(request.required_role)} />
          <DetailRow
            label="Raised by"
            value={request.requested_by_type === 'system' ? 'The system' : humanize(request.requested_by_type)}
          />
          <DetailRow label="Raised" value={clock.dateTime(request.created_at)} />
          <DetailRow
            label={request.state === 'pending' ? 'Due' : 'Was due'}
            value={clock.dateTime(request.sla_due_at)}
          />
          {request.amount_minor !== null ? (
            <DetailRow label="Amount" value={MONEY.format(request.amount_minor / 100)} />
          ) : null}
          {request.audience === 'client' ? <DetailRow label="Audience" value="Client" /> : null}
          {request.decided_at ? (
            <>
              <DetailRow label="Decided" value={clock.dateTime(request.decided_at)} />
              {request.decision_note ? <DetailRow label="Decision note" value={request.decision_note} /> : null}
              {request.evidence_ref ? <DetailRow label="Evidence" value={request.evidence_ref} /> : null}
            </>
          ) : null}
        </DetailList>

        {request.subject_type === 'proposal' && request.subject_id ? (
          <a
            href={`/api/quotations/${request.subject_id}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 block w-fit text-xs text-muted underline underline-offset-2 hover:text-ink"
          >
            Read the quotation
          </a>
        ) : null}
      </Card>

      {request.state === 'pending' ? (
        <Card className="p-4 sm:p-5">
          <ApprovalDecisionForm
            requestId={request.id}
            audience={request.audience}
            subjectType={request.subject_type}
          />
        </Card>
      ) : null}
    </div>
  );
}
