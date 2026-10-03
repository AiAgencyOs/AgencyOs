'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { bulkLeadAction } from '@/modules/crm/bulk-actions';
import type { BulkLeadOutcome } from '@/modules/crm/bulk-schema';
import { Button, cx, humanize, inputClass, selectClass } from '@/ui';

/**
 * The toolbar over a multi-selection of leads — SCR-006.
 *
 * Four actions, each the single-row door applied once per selected lead
 * by `bulkLeadAction`; the outcomes come back one per lead and are shown
 * as they were said. No optimistic anything: the list re-renders from the
 * server after the call, and a lead the door refused stays exactly as it
 * was. The status choices are the schema's own list; the transition table
 * is the service's to enforce, so an illegal move is a refusal here rather
 * than an option quietly hidden.
 */
export type BulkRoster = { userId: string; fullName: string }[];

type Mode = 'assign' | 'status' | 'tag' | 'follow_up';

export function BulkActionsBar({
  selected,
  roster,
  statuses,
  nurtureReasons,
  canAssign,
  canWrite,
  onDone,
}: {
  selected: string[];
  roster: BulkRoster;
  statuses: readonly string[];
  nurtureReasons: readonly string[];
  canAssign: boolean;
  canWrite: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(canAssign ? 'assign' : 'status');
  const [ownerId, setOwnerId] = useState('');
  const [status, setStatus] = useState('qualifying');
  const [reason, setReason] = useState('');
  const [nurtureReason, setNurtureReason] = useState('');
  const [nurtureUntil, setNurtureUntil] = useState('');
  const [tag, setTag] = useState('');
  const [followUpOn, setFollowUpOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<BulkLeadOutcome[] | null>(null);

  const apply = async () => {
    setBusy(true);
    setError(null);
    setOutcomes(null);
    const input =
      mode === 'assign'
        ? { kind: 'assign' as const, leadIds: selected, ownerId: ownerId || null }
        : mode === 'status'
          ? {
              kind: 'status' as const,
              leadIds: selected,
              status: status as never,
              reason: reason || undefined,
              nurtureReason: (nurtureReason || undefined) as never,
              nurtureUntil: nurtureUntil || undefined,
            }
          : mode === 'tag'
            ? { kind: 'tag' as const, leadIds: selected, tag }
            : // A date input gives YYYY-MM-DD; the column is timestamptz, and
              // 09:00 UTC is what the lead's own follow-up form writes.
              { kind: 'follow_up' as const, leadIds: selected, nextFollowUpAt: followUpOn ? new Date(`${followUpOn}T09:00:00Z`).toISOString() : null };
    const result = await bulkLeadAction(input);
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    setOutcomes(result.data);
    router.refresh();
    if (result.data.every((o) => o.ok)) onDone();
  };

  const modes: { key: Mode; label: string; allowed: boolean }[] = [
    { key: 'assign', label: 'Assign owner', allowed: canAssign },
    { key: 'status', label: 'Set status', allowed: canWrite },
    { key: 'tag', label: 'Add tag', allowed: canWrite },
    { key: 'follow_up', label: 'Set next follow-up', allowed: canWrite },
  ];

  return (
    <div className="flex flex-col gap-2 border-b border-[var(--wa-divider)] bg-surface-sunken px-3 py-2.5 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium">
          {selected.length} selected
        </span>
        {modes
          .filter((m) => m.allowed)
          .map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              aria-pressed={mode === m.key}
              className={cx(
                'rounded-full px-3 py-1 text-[12px] font-medium transition-colors',
                mode === m.key ? 'bg-brand text-brand-fg' : 'bg-surface text-muted ring-1 ring-inset ring-line hover:text-foreground',
              )}
            >
              {m.label}
            </button>
          ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {mode === 'assign' ? (
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={cx(selectClass, 'max-w-xs')} aria-label="Owner">
            <option value="">Nobody (clear assignment)</option>
            {roster.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.fullName}
              </option>
            ))}
          </select>
        ) : null}

        {mode === 'status' ? (
          <>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={cx(selectClass, 'max-w-xs')} aria-label="Status">
              {statuses
                .filter((s) => s !== 'converted')
                .map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
            </select>
            {status === 'disqualified' ? (
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className={cx(inputClass, 'max-w-xs')} aria-label="Reason" />
            ) : null}
            {status === 'nurture' ? (
              <>
                <select value={nurtureReason} onChange={(e) => setNurtureReason(e.target.value)} className={cx(selectClass, 'max-w-xs')} aria-label="Why not ready">
                  <option value="">Why not ready…</option>
                  {nurtureReasons.map((r) => (
                    <option key={r} value={r}>
                      {humanize(r)}
                    </option>
                  ))}
                </select>
                <input type="date" value={nurtureUntil} onChange={(e) => setNurtureUntil(e.target.value)} className={cx(inputClass, 'max-w-[11rem]')} aria-label="Come back on" />
              </>
            ) : null}
          </>
        ) : null}

        {mode === 'tag' ? (
          <input value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} placeholder="Tag to add" className={cx(inputClass, 'max-w-xs')} aria-label="Tag" />
        ) : null}

        {mode === 'follow_up' ? (
          <>
            <input type="date" value={followUpOn} onChange={(e) => setFollowUpOn(e.target.value)} className={cx(inputClass, 'max-w-[11rem]')} aria-label="Next follow-up on" />
            <span className="text-[12px] text-muted">Empty clears the reminder.</span>
          </>
        ) : null}

        <Button type="button" variant="primary" size="sm" onClick={apply} disabled={busy || selected.length === 0 || (mode === 'tag' && !tag.trim())}>
          {busy ? 'Applying…' : `Apply to ${selected.length}`}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Clear selection
        </Button>
      </div>

      {error ? (
        <p role="status" className="text-[12.5px] text-danger">
          {error}
        </p>
      ) : null}

      {outcomes ? (
        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto text-[12px]" aria-label="Outcomes">
          {outcomes.map((o) => (
            <li key={o.leadId} className={o.ok ? 'text-success' : 'text-danger'}>
              <span className="font-mono text-faint">{o.leadId.slice(0, 8)}</span> · {o.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
