'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Badge, DetailList, DetailRow, Drawer, buttonClass, humanize, statusTone } from '@/ui';

/**
 * One follow-up sequence, in full — SCR-013's detail drawer. Everything
 * shown is a column of the row (`crm.follow_up_sequences`) or the
 * situation the contract names for its key; nothing is inferred.
 */
export type SequenceDetailView = {
  id: string;
  situationName: string;
  situationKey: string;
  escalatesTo: string | null;
  rhythm: string | null;
  subject: string;
  leadId: string | null;
  status: string;
  attemptsSent: number;
  triggeredAt: string;
  nextDueAt: string | null;
  lastSentAt: string | null;
  lastEvaluatedAt: string | null;
  escalatedAt: string | null;
  stopReason: string | null;
  lastBlockReason: string | null;
  draftedAt: string | null;
  draftedBody: string | null;
  draftedLanguage: string | null;
  draftedByAgent: string | null;
  channel: string | null;
  ownerName: string | null;
  correlationId: string;
};

export function SequenceDetailButton({ view }: { view: SequenceDetailView }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('ghost', 'sm')}>
        Details
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={view.situationName}
        description={view.subject}
        actions={
          <Badge tone={statusTone(view.status)} dot>
            {humanize(view.status)}
          </Badge>
        }
        footer={
          view.leadId ? (
            <Link href={`/leads/${view.leadId}`} className={buttonClass('secondary', 'sm')}>
              Open the lead
            </Link>
          ) : null
        }
      >
        <div className="flex flex-col gap-5">
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Drafted message</h3>
            {view.draftedBody ? (
              <blockquote className="whitespace-pre-wrap rounded-lg border border-line bg-surface-sunken p-3 text-[13px] leading-relaxed">
                {view.draftedBody}
              </blockquote>
            ) : (
              <p className="text-[13px] text-muted">Nothing drafted yet for the next attempt.</p>
            )}
            {view.draftedAt ? (
              <p className="mt-1 text-[11px] text-faint">
                Drafted {view.draftedAt}
                {view.draftedByAgent ? ` by ${view.draftedByAgent}` : ''}
                {view.draftedLanguage ? ` · ${view.draftedLanguage}` : ''}
              </p>
            ) : null}
          </section>

          <DetailList>
            <DetailRow label="Situation" value={<span className="font-mono text-xs">{view.situationKey}</span>} />
            <DetailRow label="Rhythm" value={view.rhythm ? humanize(view.rhythm) : 'not stated by the contract'} />
            <DetailRow label="Escalates to" value={view.escalatesTo ? humanize(view.escalatesTo) : '—'} />
            <DetailRow label="Channel" value={view.channel ? humanize(view.channel) : 'no conversation attached'} />
            <DetailRow label="Lead owner" value={view.ownerName ?? 'unassigned'} />
            <DetailRow label="Attempts sent" value={view.attemptsSent} />
            <DetailRow label="Triggered" value={view.triggeredAt} />
            <DetailRow label="Next due" value={view.nextDueAt ?? '—'} />
            <DetailRow label="Last sent" value={view.lastSentAt ?? '—'} />
            <DetailRow label="Last evaluated" value={view.lastEvaluatedAt ?? '—'} />
            <DetailRow label="Escalated" value={view.escalatedAt ?? 'not escalated'} />
            <DetailRow label="Stop reason" value={view.stopReason ?? '—'} />
            <DetailRow label="Last block" value={view.lastBlockReason ?? '—'} />
            <DetailRow label="Correlation" value={<span className="font-mono text-xs">{view.correlationId}</span>} />
          </DetailList>

          <p className="text-[12px] text-faint">
            Read-only. Starting, stopping and escalating a sequence stay the worker&rsquo;s job under the follow-up
            contract; cancelling one would need a terminal state the table does not have.
          </p>
        </div>
      </Drawer>
    </>
  );
}
