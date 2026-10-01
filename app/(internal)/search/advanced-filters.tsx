'use client';

import { useId, useState } from 'react';

import { buttonClass, IconClose, IconPlus, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-002's advanced filter builder: stackable conditions — a field, an
 * operator and a value each, added and removed freely — posted as repeated
 * `f=field:op:value` URL parameters, so a filtered search is something a
 * person can bookmark, send or save. Plain GET form; nothing is stored here.
 *
 * Owner is the person a row belongs to (assignee, relationship owner, delivery
 * lead, author); a type with no owner ignores it, and the hint says so. Status
 * is free text against each type's own vocabulary.
 */
type Field = 'status' | 'owner' | 'created';
type Row = { id: number; field: Field; op: string; value: string };

const OPS: Record<Field, { key: string; label: string }[]> = {
  status: [{ key: 'is', label: 'is' }, { key: 'not', label: 'is not' }],
  owner: [{ key: 'is', label: 'is' }, { key: 'not', label: 'is not' }],
  created: [{ key: 'after', label: 'is on or after' }, { key: 'before', label: 'is on or before' }],
};

function parse(initial: string[]): Row[] {
  return initial.flatMap((raw, i) => {
    const [field, op, ...rest] = raw.split(':');
    if (field !== 'status' && field !== 'owner' && field !== 'created') return [];
    return [{ id: i, field, op: op ?? OPS[field][0]!.key, value: rest.join(':') }];
  });
}

export function AdvancedFilters({
  q,
  type,
  since,
  mode,
  conditions,
  roster,
  ownerApplies,
}: {
  q: string;
  type?: string;
  since?: string;
  /** The search mode (keyword / meaning / both); omitted for the default keyword mode. */
  mode?: string;
  /** The current `field:op:value` conditions. */
  conditions: string[];
  roster: { userId: string; label: string }[];
  ownerApplies: boolean;
}) {
  const uid = useId();
  const [rows, setRows] = useState<Row[]>(() => parse(conditions));
  const [next, setNext] = useState(1000);

  const update = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () => {
    setRows((rs) => [...rs, { id: next, field: 'status', op: 'is', value: '' }]);
    setNext((n) => n + 1);
  };

  return (
    <form action="/search" method="GET" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs">
      <input type="hidden" name="q" value={q} />
      {type ? <input type="hidden" name="type" value={type} /> : null}
      {since ? <input type="hidden" name="since" value={since} /> : null}
      {mode ? <input type="hidden" name="mode" value={mode} /> : null}
      <p className="text-[13px] font-semibold text-foreground">Filter builder</p>
      {rows.length === 0 ? <p className="text-xs text-muted">No conditions yet. Add one to narrow the results by status, owner or creation date.</p> : null}
      {rows.map((r, i) => (
        <div key={r.id} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1" htmlFor={`${uid}-f-${r.id}`}>
            <span className={labelClass}>{i === 0 ? 'Where' : 'And'}</span>
            <select
              id={`${uid}-f-${r.id}`}
              value={r.field}
              onChange={(e) => {
                const field = e.target.value as Field;
                update(r.id, { field, op: OPS[field][0]!.key, value: '' });
              }}
              className={selectClass}
            >
              <option value="status">Status</option>
              <option value="owner">Owner</option>
              <option value="created">Created</option>
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${uid}-o-${r.id}`}>
            <span className={labelClass}>Operator</span>
            <select id={`${uid}-o-${r.id}`} value={r.op} onChange={(e) => update(r.id, { op: e.target.value })} className={selectClass}>
              {OPS[r.field].map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[11rem] flex-col gap-1" htmlFor={`${uid}-v-${r.id}`}>
            <span className={labelClass}>Value</span>
            {r.field === 'owner' ? (
              <select id={`${uid}-v-${r.id}`} value={r.value} onChange={(e) => update(r.id, { value: e.target.value })} className={selectClass} required>
                <option value="">Choose a member…</option>
                {roster.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : r.field === 'created' ? (
              <input id={`${uid}-v-${r.id}`} type="date" value={r.value} onChange={(e) => update(r.id, { value: e.target.value })} className={inputClass} required />
            ) : (
              <input id={`${uid}-v-${r.id}`} value={r.value} maxLength={40} onChange={(e) => update(r.id, { value: e.target.value })} placeholder="e.g. qualified, issued, done" className={inputClass} required />
            )}
          </label>
          <input type="hidden" name="f" value={r.value ? `${r.field}:${r.op}:${r.value}` : ''} disabled={!r.value} />
          <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} aria-label={`Remove condition ${i + 1}`} className={buttonClass('ghost', 'sm')}>
            <IconClose size={12} />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={add} disabled={rows.length >= 8} className={buttonClass('secondary', 'sm')}>
          <IconPlus size={12} />
          Add condition
        </button>
        <button type="submit" className={buttonClass('primary', 'sm')}>
          Apply filters
        </button>
      </div>
      <p className="text-[11px] text-muted">
        {ownerApplies
          ? 'Owner is the assignee, relationship owner, delivery lead or author of the row. Status is matched against the row’s own status word.'
          : 'This type has no owner; an owner condition hides it. Status is matched against the row’s own status word.'}
      </p>
    </form>
  );
}
