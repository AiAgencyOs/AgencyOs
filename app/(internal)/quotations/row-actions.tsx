'use client';

import Link from 'next/link';
import { useState } from 'react';

import { buttonClass, Drawer } from '@/ui';

import { QuotationResponseForm, SendQuotationForm, SubmitQuotationForm } from '../leads/[leadId]/quotation-panel';

/**
 * SCR-011's list-level actions: submit for approval, send an approved quote,
 * record the client's answer — the SAME forms and doors Lead 360's quotation
 * card uses, opened here in a drawer so the list does not need a second
 * implementation. Only the action that the row's status allows (and the
 * caller's capability permits) is offered; a superseded row has none, and a
 * plan-set member moves with its set on Lead 360, so it links there.
 *
 * The forms mount only while the drawer is open, so their field ids never
 * repeat across the rows of the table.
 */
export function QuotationManageButton({
  leadId,
  proposalId,
  opportunityId,
  title,
  status,
  lapsed,
  inPlanSet,
  mayDraft,
  maySend,
}: {
  leadId: string;
  proposalId: string;
  opportunityId: string;
  title: string;
  status: string;
  lapsed: boolean;
  inPlanSet: boolean;
  mayDraft: boolean;
  maySend: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // Owner decision #13: Share (an internal link) only once the owner has approved.
  const shareable = status === 'approved' || status === 'sent' || status === 'accepted';
  const canSubmit = mayDraft && status === 'draft' && !inPlanSet;
  const canSend = maySend && status === 'approved' && !inPlanSet;
  const canAnswer = maySend && status === 'sent' && !inPlanSet;
  const nextStep =
    status === 'draft' ? 'Submit this draft to the owner for approval.'
    : status === 'approved' ? 'Approved — send it to the client.'
    : status === 'sent' ? 'Sent — record what the client answered.'
    : status === 'pending_approval' ? 'With the owner for approval. It cannot be edited or sent until they answer.'
    : status === 'superseded' ? 'A newer version replaced this one; it stays as history.'
    : 'No further step from this status.';

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('ghost', 'sm')}>
        Actions
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={nextStep}
        footer={
          <div className="flex flex-wrap items-center gap-2">
          {shareable ? (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(`${window.location.origin}/leads/${leadId}#quotations`)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
              className={buttonClass('secondary', 'sm')}
            >
              {copied ? 'Link copied' : 'Copy link'}
            </button>
          ) : null}
          <Link href={`/leads/${leadId}#quotations`} className={buttonClass('secondary', 'sm')}>
            {inPlanSet ? 'Open the plan set on the lead' : 'Open the lead — create a new version'}
          </Link>
          </div>
        }
      >
        {open ? (
          <div className="flex flex-col gap-4">
            {/* SCR-011 "PDF preview": the same document the client gets, shown here before it is opened or sent. */}
            <div className="flex flex-col gap-2">
              <button type="button" onClick={() => setPreviewing((v) => !v)} aria-expanded={previewing} className={buttonClass('secondary', 'sm')}>
                {previewing ? 'Hide the PDF preview' : 'Preview the PDF'}
              </button>
              {previewing ? (
                <iframe title={`PDF preview of ${title}`} src={`/api/quotations/${proposalId}/pdf`} className="h-[60vh] w-full rounded-lg border border-line bg-surface-sunken" />
              ) : null}
            </div>
            {canSubmit ? <SubmitQuotationForm leadId={leadId} proposalId={proposalId} /> : null}
            {canSend ? <SendQuotationForm leadId={leadId} proposalId={proposalId} conversationId={null} /> : null}
            {canAnswer ? <QuotationResponseForm leadId={leadId} proposalId={proposalId} opportunityId={opportunityId} lapsed={lapsed} /> : null}
            {!canSubmit && !canSend && !canAnswer ? <p className="text-[13px] text-muted">Nothing to do here for this quotation, or your role may not act on it.</p> : null}
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
