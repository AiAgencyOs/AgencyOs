'use client';

import Link from 'next/link';
import { useState } from 'react';

import { isClaimAwaiting } from '@/modules/finance/schema';
import { Badge, DetailList, DetailRow, Drawer, StatusBadge, buttonClass, humanize } from '@/ui';

import { PhaseNineForm } from '../close/phase-nine-forms';

/** The kinds of exception a person can open from a claim. Opening one blocks a project close until a person resolves it; it verifies and rejects nothing. */
const CLAIM_EXCEPTION_KINDS: [string, string][] = [
  ['wrong_amount', 'Wrong amount'], ['wrong_account', 'Wrong account'], ['unclear_proof', 'Unclear proof'], ['gateway_mismatch', 'Gateway mismatch'], ['duplicate_payment', 'Duplicate payment'], ['other', 'Other'],
];

export type ClaimView = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  clientName: string | null;
  amountLabel: string;
  method: string;
  reference: string | null;
  payerName: string | null;
  paidAtLabel: string | null;
  /** The link to open: the uploaded file's route when one was uploaded, else the pasted link (claimProofHref). */
  proofUrl: string | null;
  proofIsImage: boolean;
  proofUploaded: boolean;
  status: string;
  submittedAtLabel: string;
  verifiedAtLabel: string | null;
  verifiedByName: string | null;
  verificationEvidence: string | null;
  rejectedReason: string | null;
  mismatchNote: string | null;
  paymentId: string | null;
};


/**
 * The claim behind a payment, inspected without leaving the ledger — SCR-053.
 *
 * Read-only: the decision itself is made on `/invoices/verify`, where the
 * door is, and this drawer links there rather than duplicating the form.
 * The proof is rendered as an image only when its URL says it is one;
 * anything else stays a link, because guessing a content type from a URL
 * that does not state one is how a PDF renders as a broken image.
 */
export function ClaimsDrawerList({ claims }: { claims: ClaimView[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = claims.find((c) => c.id === openId) ?? null;

  return (
    <>
      <ul className="divide-y divide-line">
        {claims.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-[13px] sm:px-5">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium tabular">{c.amountLabel}</span>
                <StatusBadge status={c.status} />
                <Badge tone="neutral">{humanize(c.method)}</Badge>
              </span>
              <span className="truncate text-muted">
                {c.clientName ?? 'Unknown client'} · <span className="font-mono">{c.invoiceNumber}</span> · claimed {c.submittedAtLabel}
              </span>
            </span>
            <button type="button" onClick={() => setOpenId(c.id)} className={buttonClass('secondary', 'sm')}>
              Inspect
            </button>
          </li>
        ))}
      </ul>

      <Drawer
        open={open !== null}
        onClose={() => setOpenId(null)}
        title={open ? `${open.amountLabel} · ${open.invoiceNumber}` : ''}
        description={open ? `${open.clientName ?? 'Unknown client'} · claimed ${open.submittedAtLabel}` : undefined}
        footer={
          open ? (
            <>
              <Link href={`/invoices/${open.invoiceId}`} className={buttonClass('secondary', 'sm')}>
                Open invoice
              </Link>
              {isClaimAwaiting(open.status) ? (
                <Link href="/invoices/verify" className={buttonClass('primary', 'sm')}>
                  Decide on the queue
                </Link>
              ) : null}
            </>
          ) : null
        }
      >
        {open ? (
          <div className="flex flex-col gap-4">
            <DetailList>
              <DetailRow label="Status" value={<StatusBadge status={open.status} />} />
              <DetailRow label="Method" value={humanize(open.method)} />
              <DetailRow label="Reference" value={open.reference ? <span className="font-mono">{open.reference}</span> : '—'} />
              <DetailRow label="Payer" value={open.payerName ?? '—'} />
              <DetailRow label="Said paid on" value={open.paidAtLabel ?? '—'} />
              <DetailRow
                label="Proof"
                value={
                  open.proofUrl ? (
                    <a href={open.proofUrl} target="_blank" rel="noreferrer" className="text-brand underline-offset-2 hover:underline">
                      {open.proofUploaded ? 'Open uploaded file' : 'Open link'}
                    </a>
                  ) : (
                    'none attached'
                  )
                }
              />
            </DetailList>

            {open.proofUrl && open.proofIsImage ? (
              <img src={open.proofUrl} alt="Payment proof" className="max-h-72 w-full rounded-lg border border-line object-contain" />
            ) : null}

            {open.mismatchNote ? (
              <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning">
                Mismatch noted: {open.mismatchNote}
              </p>
            ) : null}

            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Verification decision</p>
              {open.status === 'verified' ? (
                <p className="text-[13px] leading-relaxed">
                  Verified by <span className="font-medium">{open.verifiedByName ?? 'unnamed'}</span>
                  {open.verifiedAtLabel ? ` on ${open.verifiedAtLabel}` : ''}.
                  {open.verificationEvidence ? <span className="block text-muted">Checked: {open.verificationEvidence}</span> : null}
                  {open.paymentId ? (
                    <span className="block text-muted">Ledger payment recorded.</span>
                  ) : (
                    <span className="block text-muted">The ledger payment is still a separate act.</span>
                  )}
                </p>
              ) : open.status === 'rejected' ? (
                <p className="text-[13px] leading-relaxed">
                  Rejected by <span className="font-medium">{open.verifiedByName ?? 'unnamed'}</span>
                  {open.verifiedAtLabel ? ` on ${open.verifiedAtLabel}` : ''}.
                  {open.rejectedReason ? <span className="block text-muted">Reason: {open.rejectedReason}</span> : null}
                </p>
              ) : (
                <p className="text-[13px] text-muted">Not decided yet.</p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Open an exception</p>
              <PhaseNineForm
                door="open_exception"
                hidden={{ submissionId: open.id }}
                fields={[
                  { kind: 'select', name: 'kind', label: 'Kind', options: CLAIM_EXCEPTION_KINDS },
                  { kind: 'textarea', name: 'reason', label: 'What is wrong with this claim', required: true },
                ]}
                submit="Open an exception"
                intro="Records the problem against this claim and blocks a project close until a person resolves it. It does not verify or reject the claim."
              />
            </div>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
