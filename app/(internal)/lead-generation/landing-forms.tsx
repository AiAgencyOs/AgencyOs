'use client';

import { useActionState } from 'react';

import { checkLandingAction, retireLandingAction, saveLandingAction, submitLandingAction } from '@/modules/acquisition/actions';
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

/** A new page (no pageId) or the next version of an existing one. Saving sends nothing to a host. */
export function LandingForm({ pageId, services }: { pageId?: string; services: string[] }) {
  const [state, action, pending] = useActionState(saveLandingAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-4">
      <input type="hidden" name="pageId" value={pageId ?? ''} />
      {pageId ? null : (
        <>
          <div className="sm:col-span-2"><Field label="Page name (internal)"><input name="name" required minLength={3} maxLength={120} className={inputClass} /></Field></div>
          <Field label="Address name" hint="Lowercase words and hyphens."><input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" className={inputClass} /></Field>
          <Field label="Service it sells"><select name="service" aria-label="Target service" className={selectClass}><option value="">None</option>{services.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
        </>
      )}
      <div className="sm:col-span-4"><Field label="Public address" hint="Where it will be served, e.g. https://lp.youragency.com/website. Approved with the page."><input name="publicUrl" required type="url" className={inputClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="Headline" hint="5 to 90 characters."><input name="headline" required maxLength={90} className={inputClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="Subheadline"><input name="subheadline" maxLength={200} className={inputClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="Benefits" hint="One per line: title | text. Three to six."><textarea name="benefits" required rows={4} className={textareaClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="Proof" hint="One per line: portfolio item id | caption. Only the agency's own portfolio items are allowed; testimonials are not supported."><textarea name="proof" rows={3} className={textareaClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="Questions" hint="One per line: question | answer. Up to eight."><textarea name="faq" rows={3} className={textareaClass} /></Field></div>
      <Field label="Button text"><input name="ctaText" required defaultValue="Chat on WhatsApp" maxLength={40} className={inputClass} /></Field>
      <div className="sm:col-span-2"><Field label="Privacy page"><input name="privacyUrl" required type="url" className={inputClass} /></Field></div>
      <Field label="Contact email"><input name="contactEmail" required type="email" className={inputClass} /></Field>
      <div className="flex items-center gap-3 sm:col-span-4">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>{pageId ? 'Save as the next version' : 'Save page draft'}</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

function OneButton({ versionId, action: act, label, variant = 'secondary' }: { versionId: string; action: typeof checkLandingAction; label: string; variant?: 'primary' | 'secondary' }) {
  const [state, run, pending] = useActionState(act, IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-1">
      <input type="hidden" name="versionId" value={versionId} />
      <button type="submit" disabled={pending} className={buttonClass(variant)}>{label}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export const CheckLandingButton = ({ versionId }: { versionId: string }) => <OneButton versionId={versionId} action={checkLandingAction} label="Run the checks" />;
export const SubmitLandingButton = ({ versionId }: { versionId: string }) => <OneButton versionId={versionId} action={submitLandingAction} label="Send for approval" variant="primary" />;

export function RetireLandingForm({ pageId }: { pageId: string }) {
  const [state, run, pending] = useActionState(retireLandingAction, IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-1">
      <input type="hidden" name="pageId" value={pageId} />
      <div className="flex items-end gap-2">
        <Field label="Retire - why?"><input name="reason" required minLength={3} maxLength={300} className={inputClass} /></Field>
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>Retire</button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
