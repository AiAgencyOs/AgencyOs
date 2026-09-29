'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Badge, Drawer, buttonClass } from '@/ui';

export type ReminderHistoryEntry = {
  id: string;
  kind: string;
  channel: string;
  whenLabel: string;
  note: string | null;
  messageRef: string | null;
};

/**
 * SCR-051 — the reminder history behind one row of the invoice list, opened
 * without leaving the list. Read-only: sending and recording happen on the
 * invoice, where the doors are; the drawer links there.
 */
export function ReminderHistoryButton({
  invoiceId,
  number,
  entries,
}: {
  invoiceId: string;
  number: string;
  entries: ReminderHistoryEntry[];
}) {
  const [open, setOpen] = useState(false);
  const reminders = entries.filter((e) => e.kind === 'reminder').length;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-brand hover:underline">
        {entries.length === 0 ? 'No sends' : `${reminders} reminder${reminders === 1 ? '' : 's'} · ${entries.length} send${entries.length === 1 ? '' : 's'}`}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={`Reminder history · ${number}`}
        description={entries.length === 0 ? 'Nobody has recorded sending this invoice.' : 'Every send and reminder recorded on this invoice, newest first.'}
        footer={
          <Link href={`/invoices/${invoiceId}`} className={buttonClass('primary', 'sm')}>
            Open invoice
          </Link>
        }
      >
        {entries.length > 0 ? (
          <ul className="divide-y divide-line">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 py-2 text-[13px]">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={e.kind === 'reminder' ? 'warning' : 'brand'}>{e.kind === 'reminder' ? 'reminder' : 'sent'}</Badge>
                  <span className="text-muted">{e.channel}</span>
                  <span className="ml-auto text-xs text-muted">{e.whenLabel}</span>
                </span>
                {e.note ? <span className="text-muted">{e.note}</span> : null}
                {e.messageRef ? <span className="font-mono text-xs text-muted">{e.messageRef}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Drawer>
    </>
  );
}
