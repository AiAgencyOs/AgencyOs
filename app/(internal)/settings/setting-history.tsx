'use client';

import { useState } from 'react';

import { Badge, Drawer, buttonClass } from '@/ui';

/**
 * Per-setting history — SCR-071. A small "History" button beside a setting
 * opens the drawer with every recorded change to THAT key, from the audit
 * trail (`readSettingHistory`), newest first: what it was, what it became,
 * who, when. The current value's effective date is the newest entry.
 */
export type SettingHistoryEntry = {
  auditId: number;
  before: string;
  after: string;
  actor: string;
  atLabel: string;
};

export function SettingHistory({ label, entries }: { label: string; entries: SettingHistoryEntry[] }) {
  const [open, setOpen] = useState(false);
  const latest = entries[0];

  return (
    <>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {latest ? <span>effective {latest.atLabel}</span> : <span>never changed from the panel</span>}
        <button type="button" onClick={() => setOpen(true)} className={buttonClass('ghost', 'sm')}>
          History{entries.length > 0 ? ` (${entries.length})` : ''}
        </button>
      </span>
      <Drawer open={open} onClose={() => setOpen(false)} title={`${label} — history`} description="Every recorded change, newest first, from the audit trail.">
        {entries.length === 0 ? (
          <p className="text-[13px] text-muted">No change to this setting has been recorded from the panel.</p>
        ) : (
          <ol className="divide-y divide-line text-[13px]">
            {entries.map((e) => (
              <li key={e.auditId} className="flex flex-col gap-1 py-2.5">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{e.before || '—'}</Badge>
                  <span className="text-muted">→</span>
                  <Badge tone="info">{e.after || '—'}</Badge>
                </span>
                <span className="text-xs text-muted">
                  {e.actor} · {e.atLabel} · audit #{e.auditId}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Drawer>
    </>
  );
}
