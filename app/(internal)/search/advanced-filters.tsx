import { buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-002's advanced filter builder — owner and status beside the type and
 * date chips (bucket F, stream F-A). A plain GET form, like every filter in
 * the panel: the values land in the URL, the server component reads them,
 * and a filtered search is something a person can bookmark or save.
 *
 * Owner is the person a row belongs to — the lead's assignee, the client's
 * relationship owner, the project's delivery lead, the task's assignee,
 * the quotation's author. Where the chosen type has no owner (invoices,
 * meetings) the control says so rather than silently matching nothing.
 * Status is free text against the row's own vocabulary, because seven
 * entities have seven vocabularies and a picker of forty words would be a
 * worse control than the word.
 */
export function AdvancedFilters({
  q,
  type,
  since,
  owner,
  status,
  roster,
  ownerApplies,
}: {
  q: string;
  type?: string;
  since?: string;
  owner?: string;
  status?: string;
  roster: { userId: string; label: string }[];
  ownerApplies: boolean;
}) {
  return (
    <form action="/search" method="GET" className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs">
      <input type="hidden" name="q" value={q} />
      {type ? <input type="hidden" name="type" value={type} /> : null}
      {since ? <input type="hidden" name="since" value={since} /> : null}
      <label className="flex min-w-[12rem] flex-col gap-1">
        <span className={labelClass}>Owner</span>
        <select name="owner" defaultValue={owner ?? ''} className={selectClass} disabled={!ownerApplies} aria-describedby="search-owner-hint">
          <option value="">Anyone</option>
          {roster.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-[10rem] flex-col gap-1">
        <span className={labelClass}>Status</span>
        <input name="status" defaultValue={status ?? ''} maxLength={40} placeholder="e.g. qualified, issued, done" className={inputClass} />
      </label>
      <button type="submit" className={buttonClass('secondary', 'sm')}>
        Apply filters
      </button>
      <p id="search-owner-hint" className="basis-full text-[11px] text-muted">
        {ownerApplies
          ? 'Owner is the assignee, relationship owner, delivery lead or author of the row. Status is matched against the row’s own status word.'
          : 'This type has no owner; the owner filter is ignored for it. Status is matched against the row’s own status word.'}
      </p>
    </form>
  );
}
