'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

import { Badge, Drawer, LinkButton, StatusBadge, buttonClass, humanize } from '@/ui';

import { LeadHeatBadge } from '@/modules/crm/lead-heat-badge';

import { readLeadPreviewAction, type LeadPreviewState } from './preview-actions';

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

/**
 * SCR-006 — a per-row preview of the lead without leaving the list.
 * Fetched when opened, through a server action that re-checks the session
 * and the capability; a refusal is shown in the drawer verbatim. Dates are
 * formatted here with the browser's locale and zone rather than the agency
 * clock (a server helper); the drawer says so.
 */
export function LeadPreviewButton({ leadId, name }: { leadId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LeadPreviewState | null>(null);
  const [pending, startTransition] = useTransition();

  const load = () => {
    setOpen(true);
    if (state?.status === 'ok') return;
    startTransition(async () => {
      setState(await readLeadPreviewAction(leadId));
    });
  };

  const when = (value: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

  return (
    <>
      <button type="button" onClick={load} className={buttonClass('ghost', 'sm')}>
        Preview
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        description="A read of the lead, in your browser's time zone."
        footer={<LinkButton href={`/leads/${leadId}`} variant="primary" size="sm">Open Lead 360</LinkButton>}
      >
        {pending || state === null ? (
          <p className="text-[13px] text-muted">Reading…</p>
        ) : state.status === 'error' ? (
          <p role="status" className="text-[13px] text-danger">{state.message}</p>
        ) : (
          <div className="flex flex-col gap-4 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={state.preview.status} />
              <span className="text-muted">via {humanize(state.preview.source)}</span>
              {state.preview.deal ? <Badge tone="info">Deal: {humanize(state.preview.deal.stage)} · {money(state.preview.deal.valueMinor, state.preview.deal.currency)}</Badge> : null}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted">Contact</dt>
              <dd>{state.preview.contact.name ?? state.preview.title}{state.preview.contact.company ? ` · ${state.preview.contact.company}` : ''}</dd>
              <dt className="text-muted">Phone</dt>
              <dd className="font-mono text-xs">{state.preview.contact.phone ?? '—'}</dd>
              <dt className="text-muted">Email</dt>
              <dd>{state.preview.contact.email ?? '—'}</dd>
              <dt className="text-muted">Assigned</dt>
              <dd>{state.preview.assignedEmail?.split('@')[0] ?? 'Unassigned'}</dd>
              <dt className="text-muted">Next follow-up</dt>
              <dd>{state.preview.nextFollowUpAt ? when(state.preview.nextFollowUpAt) : 'None set'}</dd>
              <dt className="text-muted">Heat</dt>
              <dd>
                <LeadHeatBadge label={state.preview.heat.label} title={state.preview.heat.title} />
              </dd>
              {state.preview.tags.length > 0 ? (
                <>
                  <dt className="text-muted">Tags</dt>
                  <dd className="flex flex-wrap gap-1">{state.preview.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</dd>
                </>
              ) : null}
            </dl>
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Last messages</p>
              {state.preview.lastMessages.length === 0 ? (
                <p className="text-muted">No conversation yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5 border-l-2 border-line pl-3">
                  {state.preview.lastMessages.map((m) => (
                    <li key={m.id}>
                      <span className="font-medium">{m.incoming ? 'Client' : 'Us'}</span> <span className="text-xs text-muted">{when(m.occurredAt)}</span>
                      <p className="text-muted">{m.body || '(media message)'}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Link href={`/leads/${leadId}#composer`} className="text-xs font-medium text-brand hover:underline">
              Reply on the lead →
            </Link>
          </div>
        )}
      </Drawer>
    </>
  );
}
