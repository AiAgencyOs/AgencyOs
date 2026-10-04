'use client';

import { useActionState } from 'react';

import { blockProspectAction, liftBlockAction, saveQualificationModelAction } from '@/modules/acquisition/actions';
import { FACTOR_LABEL, QUALIFICATION_FACTORS } from '@/modules/acquisition/qualification-vocabulary';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function QualificationModelForm({ weights }: { weights: Record<string, number> }) {
  const [state, action, pending] = useActionState(saveQualificationModelAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-3">
      {QUALIFICATION_FACTORS.map((f) => (
        <Field key={f} label={FACTOR_LABEL[f]}>
          <input name={f} inputMode="numeric" defaultValue={weights[f] ?? ''} placeholder="0-100" className={inputClass} />
        </Field>
      ))}
      <div className="sm:col-span-3"><Field label="What changed? (optional)"><input name="note" maxLength={500} className={inputClass} /></Field></div>
      <div className="flex items-center gap-3 sm:col-span-3">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>Save as a new version</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function BlockForm() {
  const [state, action, pending] = useActionState(blockProspectAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_2fr_2fr_auto] sm:items-end">
      <Field label="Block a">
        <select name="kind" aria-label="What to block" className={selectClass}>
          <option value="domain">domain</option>
          <option value="email">email address</option>
          <option value="company">company</option>
        </select>
      </Field>
      <Field label="Value" hint="e.g. competitor.com"><input name="value" required maxLength={200} className={inputClass} /></Field>
      <Field label="Why"><input name="reason" required maxLength={300} className={inputClass} /></Field>
      <button type="submit" disabled={pending} className={buttonClass('danger')}>Block</button>
      <div className="sm:col-span-4"><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

export function LiftBlockForm({ blockId, isOwner }: { blockId: string; isOwner: boolean }) {
  const [state, action, pending] = useActionState(liftBlockAction, IDLE_STATE);
  if (!isOwner) return <span className="text-xs text-muted">Only the owner can lift a block.</span>;
  return (
    <form action={action} className="flex items-end gap-2">
      <input type="hidden" name="blockId" value={blockId} />
      <input name="reason" required maxLength={300} placeholder="Why lift it?" aria-label="Reason for lifting" className={inputClass} />
      <button type="submit" disabled={pending} className={buttonClass('secondary')}>Lift</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
