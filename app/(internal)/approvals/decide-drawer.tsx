'use client';

import { useState } from 'react';

import { Badge, buttonClass, DetailList, DetailRow, Drawer } from '@/ui';

import { ApprovalDecisionForm } from './approval-decision-form';

/**
 * The shared rule's "approval actions in a drawer" (bucket F, stream F-A):
 * on /approvals a request's Approve / Request changes / Reject open in the
 * right-hand drawer, with the request's facts above the SAME
 * `ApprovalDecisionForm` the request's own page uses — one door, one form,
 * two places. The queue row stays a summary; deciding is a deliberate
 * second step with the evidence in view.
 */
export function DecideInDrawer({
  requestId,
  audience,
  subjectType,
  subjectLabel,
  summary,
  amountLabel,
  requiredRole,
  dueLabel,
  overdue,
  quotationHref,
}: {
  requestId: string;
  audience: string;
  subjectType: string;
  subjectLabel: string;
  summary: string | null;
  amountLabel: string | null;
  requiredRole: string;
  dueLabel: string;
  overdue: boolean;
  quotationHref: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('primary', 'sm')}>
        Decide
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={`Decide: ${subjectLabel}`}
        description={summary ?? 'No summary was given when this was raised.'}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {audience === 'client' ? <Badge tone="info">client</Badge> : null}
            <Badge tone={overdue ? 'danger' : 'neutral'} dot={overdue}>
              {overdue ? 'Overdue since ' : 'Due '}
              {dueLabel}
            </Badge>
          </div>
          <DetailList>
            <DetailRow label="Needs" value={requiredRole.replace('_', ' ')} />
            {amountLabel ? <DetailRow label="Amount" value={amountLabel} /> : null}
            {quotationHref ? (
              <DetailRow
                label="Document"
                value={
                  <a href={quotationHref} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    Read the quotation before deciding
                  </a>
                }
              />
            ) : null}
          </DetailList>
          <div className="border-t border-line pt-3">
            <ApprovalDecisionForm requestId={requestId} audience={audience} subjectType={subjectType} />
          </div>
        </div>
      </Drawer>
    </>
  );
}
