'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Badge, Drawer, buttonClass, humanize, statusTone } from '@/ui';

/**
 * A deal's quotation versions, newest first — SCR-011's version-history
 * drawer. `sales.proposals` carries `version` and no `supersedes` column:
 * the chain is the version order within one opportunity, and
 * `draft_proposal` marks the previous live version superseded when a new
 * one is drafted. So "supersedes" here is v(n−1) of the same deal, which is
 * exactly what the database function did, not a guess.
 */
export type VersionRow = {
  id: string;
  version: number;
  title: string;
  status: string;
  total: string;
  raised: string;
  sentAt: string | null;
  decidedAt: string | null;
  planLabel: string | null;
};

export function VersionHistoryButton({
  dealName,
  leadId,
  versions,
}: {
  dealName: string;
  leadId: string;
  versions: VersionRow[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('ghost', 'sm')}>
        {versions.length} version{versions.length === 1 ? '' : 's'}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={dealName}
        description="Every version raised on this deal. A superseded version stays readable; it is history, not a mistake."
        footer={
          <Link href={`/leads/${leadId}`} className={buttonClass('secondary', 'sm')}>
            Open the lead
          </Link>
        }
      >
        <ol className="flex flex-col gap-3">
          {versions.map((v, i) => {
            const previous = versions[i + 1] ?? null;
            return (
              <li key={v.id} className="rounded-lg border border-line bg-surface-sunken p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold">v{v.version}</span>
                  <Badge tone={statusTone(v.status)} dot>
                    {humanize(v.status)}
                  </Badge>
                  {v.planLabel ? <Badge tone="neutral">{v.planLabel}</Badge> : null}
                  <span className="ml-auto text-[11px] text-faint">{v.raised}</span>
                </div>
                <p className="mt-1.5 text-[13px] font-medium">{v.title}</p>
                <p className="text-[13px] text-muted">
                  {v.total}
                  {v.sentAt ? ` · sent ${v.sentAt}` : ''}
                  {v.decidedAt ? ` · decided ${v.decidedAt}` : ''}
                </p>
                <p className="mt-1 text-[11px] text-faint">
                  {previous ? `Supersedes v${previous.version}` : 'First version on this deal'}
                </p>
              </li>
            );
          })}
        </ol>
      </Drawer>
    </>
  );
}
