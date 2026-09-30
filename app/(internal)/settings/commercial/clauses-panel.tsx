'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { CLAUSE_MAX_LENGTH, CLAUSE_MIN_LENGTH } from '@/modules/sales/quotation-clauses';
import { buttonClass, cx, FormMessage, textareaClass } from '@/ui';

import { publishQuotationClauseAction } from '../actions';

/** One published version, already formatted by the server so the client never renders a locale-dependent date. */
export type ClauseHistoryRow = {
  version: number;
  body: string;
  by: string | null;
  when: string;
};

export type ClauseCard = {
  key: string;
  label: string;
  hint: string;
  /** The text a quotation would print today. */
  body: string;
  /** Null when nobody has published: the code default is in force. */
  version: number | null;
  by: string | null;
  when: string | null;
  history: ClauseHistoryRow[];
};

function PublishForm({ clauseKey, label, body }: { clauseKey: string; label: string; body: string }) {
  const [state, action, pending] = useActionState(publishQuotationClauseAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="clause_key" value={clauseKey} />
      <textarea
        name="body"
        required
        rows={3}
        minLength={CLAUSE_MIN_LENGTH}
        maxLength={CLAUSE_MAX_LENGTH}
        defaultValue={body}
        aria-label={`${label} — new wording`}
        className={cx(textareaClass, 'text-[13px]')}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Publishing…' : 'Publish new version'}
        </button>
        <span className="text-xs text-muted">
          One line of plain text. Earlier versions are kept; issued quotations keep the one they printed.
        </span>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

/**
 * The four quotation clauses the owner can put in their own words — audit B-6.
 * Everyone internal sees the text; only an owner or ops admin gets the form.
 */
export function QuotationClausesPanel({ clauses, canEdit }: { clauses: ClauseCard[]; canEdit: boolean }) {
  return (
    <ul className="flex flex-col gap-4">
      {clauses.map((c) => (
        <li key={c.key} className="flex flex-col gap-2 rounded-lg border border-line p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-[13px] font-medium">{c.label}</h4>
            <span className="text-xs text-muted">
              {c.version === null
                ? 'Standard wording — never edited'
                : `Version ${c.version} · ${c.by ?? 'unknown'} · ${c.when ?? ''}`}
            </span>
          </div>
          <p className="text-xs text-muted">{c.hint}</p>
          {canEdit ? (
            <PublishForm clauseKey={c.key} label={c.label} body={c.body} />
          ) : (
            <p className="text-[13px]">{c.body}</p>
          )}
          {c.history.length > 0 ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted">Version history ({c.history.length})</summary>
              <ol className="mt-2 flex flex-col gap-2">
                {c.history.map((h) => (
                  <li key={h.version} className="rounded-md border border-line p-2">
                    <span className="font-medium">Version {h.version}</span>
                    <span className="text-muted">
                      {' '}
                      · {h.by ?? 'unknown'} · {h.when}
                    </span>
                    <p className="mt-1 text-[13px]">{h.body}</p>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
