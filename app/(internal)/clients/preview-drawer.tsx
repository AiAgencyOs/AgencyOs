'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

import { Badge, Drawer, LinkButton, StatusBadge, buttonClass, humanize } from '@/ui';

import { readClientPreviewAction, type ClientPreviewState } from './preview-actions';

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
}

/**
 * SCR-014 — a per-row preview of the client without leaving the registry.
 * Fetched when opened, through a server action that re-checks the session
 * and the capability; a refusal is shown in the drawer verbatim.
 *
 * Dates are formatted here with the browser's locale and zone rather than
 * the agency clock, which is a server helper; the drawer marks them as such.
 */
export function ClientPreviewButton({ clientId, name }: { clientId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ClientPreviewState | null>(null);
  const [pending, startTransition] = useTransition();

  const load = () => {
    setOpen(true);
    if (state?.status === 'ok') return;
    startTransition(async () => {
      setState(await readClientPreviewAction(clientId));
    });
  };

  const when = (value: string) =>
    new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

  return (
    <>
      <button type="button" onClick={load} className={buttonClass('ghost', 'sm')}>
        Preview
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        description="Pending invoices, recent messages and the next follow-up."
        footer={<LinkButton href={`/clients/${clientId}`} variant="primary" size="sm">Open client</LinkButton>}
      >
        {pending || state === null ? (
          <p className="text-[13px] text-muted">Loading…</p>
        ) : state.status === 'error' ? (
          <p role="status" className="text-[13px] text-danger">{state.message}</p>
        ) : (
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Next follow-up</h3>
              {state.preview.nextFollowUp ? (
                <p className="text-[13px]">
                  <span className="font-medium text-foreground">{when(state.preview.nextFollowUp.at)}</span>{' '}
                  <span className="text-muted">
                    · {state.preview.nextFollowUp.source === 'sequence' ? 'automated sequence' : 'set on the lead'} ·{' '}
                    <Link href={`/leads/${state.preview.nextFollowUp.leadId}`} className="underline-offset-2 hover:underline">
                      {state.preview.nextFollowUp.leadTitle}
                    </Link>
                  </span>
                </p>
              ) : (
                <p className="text-[13px] text-muted">Nothing scheduled on any of this client’s leads.</p>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Pending invoices{' '}
                <span className="normal-case tracking-normal">
                  · {money(state.preview.outstandingMinor, state.preview.currency)} outstanding
                </span>
              </h3>
              {state.preview.pendingInvoices.length === 0 ? (
                <p className="text-[13px] text-muted">Nothing outstanding.</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {state.preview.pendingInvoices.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                      <Link href={`/invoices/${i.id}`} className="font-mono text-xs font-medium hover:underline">
                        {i.number}
                      </Link>
                      <span className="flex items-center gap-2">
                        <StatusBadge status={i.status} />
                        <span className="tabular text-muted">
                          {money(i.totalMinor - i.paidMinor, state.preview.currency)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Recent communication</h3>
              {state.preview.recentMessages.length === 0 ? (
                <p className="text-[13px] text-muted">No project-group messages yet.</p>
              ) : (
                <ul className="flex flex-col gap-2 border-l-2 border-line pl-3">
                  {state.preview.recentMessages.map((m) => (
                    <li key={m.id} className="text-[13px]">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={m.direction === 'inbound' ? 'brand' : 'neutral'}>
                          {m.direction === 'inbound' ? 'Client' : humanize(m.authorType)}
                        </Badge>
                        <span className="text-xs text-muted">{m.projectName} · {when(m.occurredAt)}</span>
                      </span>
                      <p className="mt-0.5 text-muted">{m.body ?? '(no text — media message)'}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </Drawer>
    </>
  );
}
