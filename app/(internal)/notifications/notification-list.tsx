'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';

import { SEVERITY_LABEL, SEVERITY_TONE, type Severity } from '@/lib/admin/escalation-types';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass, cx, DetailList, DetailRow, Drawer, FormMessage, inputClass, selectClass } from '@/ui';

import { ACTION_ITEMS_CHANGED_EVENT } from './changed-event';
import { EscalateControl, type EscalationView } from './escalate-form';
import { setNotificationStateAction } from './state-actions';

export type NotificationRow = {
  key: string;
  title: string;
  detail: string;
  href: string;
  urgent: boolean;
  /** SCR-003's severity chip, derived by the reader (bucket F). */
  severity: Severity;
  /** The source the row came from — the escalation's subject type. */
  category: string;
  categoryLabel: string;
  /** The open or acknowledged escalation on this row, if any. */
  escalation: EscalationView | null;
  attention: boolean;
  state: {
    state: 'unread' | 'read' | 'snoozed' | 'resolved';
    snoozedUntil: string | null;
    assignedToName: string | null;
    note: string | null;
    assignedToMe: boolean;
    byName: string | null;
  } | null;
  /** Already formatted by the agency clock — the snooze end, if any. */
  snoozedUntilLabel: string | null;
};

export type RosterOption = { userId: string; fullName: string };

const SNOOZE_CHOICES = [
  { key: '1h', label: 'for an hour', ms: 60 * 60 * 1000 },
  { key: '4h', label: 'for four hours', ms: 4 * 60 * 60 * 1000 },
  { key: '1d', label: 'until tomorrow', ms: 24 * 60 * 60 * 1000 },
  { key: '1w', label: 'for a week', ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

function snoozeUntil(key: string): string {
  const choice = SNOOZE_CHOICES.find((c) => c.key === key) ?? SNOOZE_CHOICES[0];
  return new Date(Date.now() + choice.ms).toISOString();
}

/**
 * The inbox rows with SCR-003's controls: a checkbox per row and a batch
 * bar (mark read, snooze, resolve, assign) over the selection, plus the
 * same four doors inline on each row. Every button posts to the one Server
 * Action; the response is shown verbatim. The rows themselves are still
 * derived by the page — this component only annotates them.
 */
export function NotificationList({ rows, roster, canAnswer }: { rows: NotificationRow[]; roster: RosterOption[]; canAnswer: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.key));
  const openRow = openKey ? (rows.find((r) => r.key === openKey) ?? null) : null;

  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      <BatchBar
        keys={[...selected]}
        roster={roster}
        allSelected={allSelected}
        onToggleAll={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.key)))}
        onDone={() => setSelected(new Set())}
      />
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.key} className={cx('flex flex-col gap-2 px-4 py-3 text-sm sm:px-5', !r.attention && 'opacity-70')}>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={selected.has(r.key)}
                onChange={() => toggle(r.key)}
                aria-label={`Select ${r.title}`}
                className="mt-1 h-4 w-4 shrink-0 accent-brand"
              />
              <Link href={r.href} className="flex min-w-0 flex-1 flex-col gap-0.5 rounded hover:bg-surface-hover">
                <span className={`font-medium ${r.urgent && r.attention ? 'text-danger' : 'text-foreground'}`}>
                  {r.urgent ? <span className="sr-only">Urgent: </span> : null}
                  {r.title}
                </span>
                <span className="text-xs text-muted">{r.detail}</span>
              </Link>
              <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <Badge tone={SEVERITY_TONE[r.severity]} dot={r.severity === 'critical'}>
                  {SEVERITY_LABEL[r.severity]}
                </Badge>
                {r.state?.state === 'snoozed' ? (
                  <Badge tone={r.attention ? 'warning' : 'neutral'} dot>
                    {r.attention ? 'Snooze ended' : `Snoozed${r.snoozedUntilLabel ? ` until ${r.snoozedUntilLabel}` : ''}`}
                  </Badge>
                ) : null}
                {r.state?.state === 'resolved' ? <Badge tone="success" dot>Resolved</Badge> : null}
                {r.state?.state === 'read' ? <Badge tone="neutral">Read</Badge> : null}
                {r.state?.assignedToName ? (
                  <Badge tone="info">{r.state.assignedToMe ? `Assigned to you${r.state.byName ? ` by ${r.state.byName}` : ''}` : `Assigned to ${r.state.assignedToName}`}</Badge>
                ) : null}
                {/* SCR-003 "Notification detail drawer" (bucket F): the row's
                    facts, its state controls and its escalation in one panel. */}
                <button type="button" onClick={() => setOpenKey(r.key)} className={buttonClass('ghost', 'sm')}>
                  Details
                </button>
              </span>
            </div>
            {r.state?.note ? <p className="pl-7 text-xs text-muted">Note: {r.state.note}</p> : null}
            <div className="flex flex-col gap-1.5 pl-7">
              <RowControls itemKey={r.key} current={r.state?.state ?? 'unread'} roster={roster} />
              {/* SCR-003 "Escalate to owner or ops admin" — a recorded
                  escalation through core.escalate, not a link (bucket F). */}
              <EscalateControl subjectType={r.category} subjectKey={r.key} title={r.title} escalation={r.escalation} canAnswer={canAnswer} compact />
            </div>
          </li>
        ))}
      </ul>

      <NotificationDrawer row={openRow} roster={roster} canAnswer={canAnswer} onClose={() => setOpenKey(null)} />
    </div>
  );
}

/**
 * SCR-003's notification detail drawer — one row in full: what it is,
 * where it came from, how urgent, its current state and who has it, its
 * escalation, and every door the row offers. Opening the source record is
 * a link, exactly as on the row.
 */
function NotificationDrawer({ row, roster, canAnswer, onClose }: { row: NotificationRow | null; roster: RosterOption[]; canAnswer: boolean; onClose: () => void }) {
  return (
    <Drawer open={row !== null} onClose={onClose} title={row?.title ?? 'Notification'} description={row?.detail}>
      {row ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={SEVERITY_TONE[row.severity]} dot={row.severity === 'critical'}>
              {SEVERITY_LABEL[row.severity]}
            </Badge>
            <Badge tone="neutral">{row.categoryLabel}</Badge>
            {row.state?.state ? <Badge tone={row.state.state === 'resolved' ? 'success' : 'neutral'}>{row.state.state}</Badge> : null}
          </div>
          <DetailList>
            <DetailRow label="Source" value={<><Link href={row.href} className="font-medium text-brand hover:underline">
                Open the record
              </Link></>} />
            <DetailRow label="Needs you" value={<>{row.attention ? 'Yes' : 'No — read, snoozed or resolved'}</>} />
            {row.state?.assignedToName ? (
              <DetailRow label="Assigned" value={<>{row.state.assignedToMe ? `to you${row.state.byName ? ` by ${row.state.byName}` : ''}` : `to ${row.state.assignedToName}`}</>} />
            ) : null}
            {row.state?.state === 'snoozed' && row.snoozedUntilLabel ? <DetailRow label="Snoozed until" value={<>{row.snoozedUntilLabel}</>} /> : null}
            {row.state?.note ? <DetailRow label="Note" value={<>{row.state.note}</>} /> : null}
            <DetailRow label="Reference" value={<><span className="font-mono text-[11px] text-faint">{row.key}</span></>} />
          </DetailList>
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">State</p>
            <RowControls itemKey={row.key} current={row.state?.state ?? 'unread'} roster={roster} />
          </div>
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Escalation</p>
            <EscalateControl subjectType={row.category} subjectKey={row.key} title={row.title} escalation={row.escalation} canAnswer={canAnswer} />
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

function useNotifyBell(status: string) {
  useEffect(() => {
    if (status === 'success') window.dispatchEvent(new Event(ACTION_ITEMS_CHANGED_EVENT));
  }, [status]);
}

function RowControls({ itemKey, current, roster }: { itemKey: string; current: string; roster: RosterOption[] }) {
  const [state, action, pending] = useActionState(setNotificationStateAction, IDLE_STATE);
  const [mode, setMode] = useState<'idle' | 'snooze' | 'resolve' | 'assign'>('idle');
  useNotifyBell(state.status);
  useEffect(() => {
    if (state.status === 'success') setMode('idle');
  }, [state]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <form action={action}>
          <input type="hidden" name="key" value={itemKey} />
          <input type="hidden" name="state" value={current === 'read' ? 'unread' : 'read'} />
          <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
            {current === 'read' ? 'Mark unread' : 'Mark read'}
          </button>
        </form>
        {current !== 'resolved' ? (
          <>
            <button type="button" onClick={() => setMode(mode === 'snooze' ? 'idle' : 'snooze')} className={buttonClass('ghost', 'sm')}>
              Snooze
            </button>
            <button type="button" onClick={() => setMode(mode === 'resolve' ? 'idle' : 'resolve')} className={buttonClass('ghost', 'sm')}>
              Resolve
            </button>
          </>
        ) : null}
        {roster.length > 0 ? (
          <button type="button" onClick={() => setMode(mode === 'assign' ? 'idle' : 'assign')} className={buttonClass('ghost', 'sm')}>
            Assign
          </button>
        ) : null}
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>

      {mode === 'snooze' ? (
        <SnoozeForm keys={[itemKey]} action={action} pending={pending} />
      ) : mode === 'resolve' ? (
        <ResolveForm keys={[itemKey]} action={action} pending={pending} />
      ) : mode === 'assign' ? (
        <AssignForm keys={[itemKey]} action={action} pending={pending} roster={roster} />
      ) : null}
    </div>
  );
}

type FormAction = (formData: FormData) => void;

function Keys({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((k) => (
        <input key={k} type="hidden" name="key" value={k} />
      ))}
    </>
  );
}

function SnoozeForm({ keys, action, pending }: { keys: string[]; action: FormAction; pending: boolean }) {
  const [choice, setChoice] = useState<string>('1d');
  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5">
      <Keys keys={keys} />
      <input type="hidden" name="state" value="snoozed" />
      <input type="hidden" name="snoozedUntil" value={snoozeUntil(choice)} />
      <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Snooze for" className={cx(selectClass, 'h-8 w-44 text-[13px]')}>
        {SNOOZE_CHOICES.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Snoozing…' : 'Snooze'}
      </button>
    </form>
  );
}

function ResolveForm({ keys, action, pending }: { keys: string[]; action: FormAction; pending: boolean }) {
  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5">
      <Keys keys={keys} />
      <input type="hidden" name="state" value="resolved" />
      <input name="note" maxLength={2000} placeholder="What was done (optional)" aria-label="Resolution note" className={cx(inputClass, 'h-8 w-64 text-[13px]')} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Resolving…' : 'Resolve'}
      </button>
    </form>
  );
}

function AssignForm({ keys, action, pending, roster }: { keys: string[]; action: FormAction; pending: boolean; roster: RosterOption[] }) {
  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5">
      <Keys keys={keys} />
      <input type="hidden" name="state" value="read" />
      <select name="assignedTo" required defaultValue="" aria-label="Assign to" className={cx(selectClass, 'h-8 w-52 text-[13px]')}>
        <option value="" disabled>
          Choose a member…
        </option>
        {roster.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.fullName}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Assigning…' : 'Assign'}
      </button>
    </form>
  );
}

function BatchBar({
  keys,
  roster,
  allSelected,
  onToggleAll,
  onDone,
}: {
  keys: string[];
  roster: RosterOption[];
  allSelected: boolean;
  onToggleAll: () => void;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(setNotificationStateAction, IDLE_STATE);
  const [mode, setMode] = useState<'idle' | 'snooze' | 'resolve' | 'assign'>('idle');
  useNotifyBell(state.status);
  // `onDone` is a fresh closure each render; the effect keys on the response.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (state.status === 'success') {
      setMode('idle');
      onDoneRef.current();
    }
  }, [state]);

  const none = keys.length === 0;
  return (
    <div className="flex flex-col gap-2 border-b border-line px-4 py-2.5 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label="Select all" className="h-4 w-4 accent-brand" />
          {none ? 'Select rows to act on several at once' : `${keys.length} selected`}
        </label>
        <form action={action}>
          <Keys keys={keys} />
          <input type="hidden" name="state" value="read" />
          <button type="submit" disabled={none || pending} className={buttonClass('secondary', 'sm')}>
            Mark read
          </button>
        </form>
        <button type="button" disabled={none} onClick={() => setMode(mode === 'snooze' ? 'idle' : 'snooze')} className={buttonClass('secondary', 'sm')}>
          Snooze
        </button>
        <button type="button" disabled={none} onClick={() => setMode(mode === 'resolve' ? 'idle' : 'resolve')} className={buttonClass('secondary', 'sm')}>
          Resolve
        </button>
        {roster.length > 0 ? (
          <button type="button" disabled={none} onClick={() => setMode(mode === 'assign' ? 'idle' : 'assign')} className={buttonClass('secondary', 'sm')}>
            Assign
          </button>
        ) : null}
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
      {!none && mode === 'snooze' ? <SnoozeForm keys={keys} action={action} pending={pending} /> : null}
      {!none && mode === 'resolve' ? <ResolveForm keys={keys} action={action} pending={pending} /> : null}
      {!none && mode === 'assign' ? <AssignForm keys={keys} action={action} pending={pending} roster={roster} /> : null}
    </div>
  );
}
