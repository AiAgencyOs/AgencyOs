'use client';

import { useActionState } from 'react';

import { blockProspectAction, checkDraftAction, liftBlockAction, recordFactAction, saveQualificationModelAction, scoreProspectAction } from '@/modules/acquisition/actions';
import { FACTOR_LABEL, QUALIFICATION_FACTORS } from '@/modules/acquisition/qualification-vocabulary';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

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

type ProspectOption = { id: string; email: string; name: string | null; company: string | null };
const label = (p: ProspectOption) => `${p.name ?? p.email}${p.company ? ` - ${p.company}` : ''} (${p.email})`;

/** A person scores a prospect from what they know. A factor left empty is MISSING and lowers the score; the Admin's rules can still refuse it. */
export function ScoreProspectForm({ prospects }: { prospects: ProspectOption[] }) {
  const [state, run, pending] = useActionState(scoreProspectAction, IDLE_STATE);
  return (
    <form action={run} className="grid gap-3 sm:grid-cols-4">
      <div className="sm:col-span-4"><Field label="Prospect"><select name="prospectId" aria-label="Prospect" required className={selectClass}>{prospects.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}</select></Field></div>
      {QUALIFICATION_FACTORS.map((f) => <Field key={f} label={FACTOR_LABEL[f]} hint="0 to 100, or empty if not known"><input name={`f_${f}`} inputMode="numeric" className={inputClass} /></Field>)}
      <div className="sm:col-span-4"><Field label="Why"><textarea name="reasoning" rows={2} maxLength={2000} className={textareaClass} /></Field></div>
      <div className="flex items-center gap-3 sm:col-span-4"><button type="submit" disabled={pending} className={buttonClass('primary')}>Record the decision</button><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

/** Something actually known about a person, with where it came from. Only a recorded fact can be cited in a message to them. */
export function RecordFactForm({ prospects }: { prospects: ProspectOption[] }) {
  const [state, run, pending] = useActionState(recordFactAction, IDLE_STATE);
  return (
    <form action={run} className="grid gap-3 sm:grid-cols-4">
      <div className="sm:col-span-2"><Field label="Prospect"><select name="prospectId" aria-label="Prospect" required className={selectClass}>{prospects.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}</select></Field></div>
      <Field label="Where it came from"><select name="sourceKind" aria-label="Source" className={selectClass}>{['website', 'linkedin', 'directory', 'press', 'manual', 'email_reply'].map((k) => <option key={k} value={k}>{k.replaceAll('_', ' ')}</option>)}</select></Field>
      <Field label="Link" hint="Required for a web source."><input name="sourceUrl" type="url" className={inputClass} /></Field>
      <div className="sm:col-span-4"><Field label="The fact"><textarea name="fact" required rows={2} maxLength={600} className={textareaClass} /></Field></div>
      <div className="flex items-center gap-3 sm:col-span-4"><button type="submit" disabled={pending} className={buttonClass('secondary')}>Record the fact</button><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

/** A drafted message is checked BEFORE it can be used: every claim about the person must cite a fact recorded about THEM. */
export function CheckDraftForm({ prospects }: { prospects: ProspectOption[] }) {
  const [state, run, pending] = useActionState(checkDraftAction, IDLE_STATE);
  return (
    <form action={run} className="grid gap-3 sm:grid-cols-4">
      <div className="sm:col-span-2"><Field label="Prospect"><select name="prospectId" aria-label="Prospect" required className={selectClass}>{prospects.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}</select></Field></div>
      <div className="sm:col-span-2"><Field label="Subject"><input name="subject" required maxLength={300} className={inputClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="The message"><textarea name="body" required rows={6} className={textareaClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="Claims about them" hint="One per line: the exact words used in the message | the fact id. Leave empty if the message says nothing about them."><textarea name="claims" rows={3} className={textareaClass} /></Field></div>
      <div className="flex items-center gap-3 sm:col-span-4"><button type="submit" disabled={pending} className={buttonClass('secondary')}>Check the draft</button><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}
