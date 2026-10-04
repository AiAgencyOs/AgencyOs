'use client';

import { useActionState } from 'react';

import { checkAdVersionAction, requestAdChangeAction, saveAdPlanAction, submitAdVersionAction } from '@/modules/acquisition/actions';
import type { AdPlatform } from '@/modules/acquisition/ad-vocabulary';
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

/** A new campaign (no campaignId) or the next version of an existing one. Saving sends nothing to a platform. */
export function AdPlanForm({ platform, campaignId, services }: { platform: AdPlatform; campaignId?: string; services: string[] }) {
  const [state, action, pending] = useActionState(saveAdPlanAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-4">
      <input type="hidden" name="platform" value={platform} />
      <input type="hidden" name="campaignId" value={campaignId ?? ''} />
      {campaignId ? null : (
        <>
          <div className="sm:col-span-2"><Field label="Campaign name"><input name="name" required minLength={3} maxLength={120} className={inputClass} /></Field></div>
          <div className="sm:col-span-2">
            <Field label="Service it sells"><select name="service" aria-label="Target service" className={selectClass}><option value="">None</option>{services.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
          </div>
        </>
      )}
      <Field label="Daily budget (₹)" hint="Whole rupees; paise allowed."><input name="daily" required inputMode="decimal" className={inputClass} /></Field>
      <Field label="Total budget (₹)" hint="Optional."><input name="total" inputMode="decimal" className={inputClass} /></Field>
      <Field label="Starts"><input name="startDate" type="date" className={inputClass} /></Field>
      <Field label="Ends"><input name="endDate" type="date" className={inputClass} /></Field>
      {platform === 'meta_ads' ? (
        <>
          <div className="sm:col-span-2"><Field label="Locations" hint="Separated by commas."><input name="locations" required className={inputClass} /></Field></div>
          <Field label="Youngest age"><input name="ageMin" type="number" min={18} max={65} defaultValue={25} className={inputClass} /></Field>
          <Field label="Oldest age"><input name="ageMax" type="number" min={18} max={65} defaultValue={55} className={inputClass} /></Field>
          <div className="sm:col-span-4"><Field label="Headline" hint="Up to 40 characters."><input name="headline" required maxLength={40} className={inputClass} /></Field></div>
          <div className="sm:col-span-4"><Field label="Primary text" hint="20 to 500 characters. People who tap the ad open WhatsApp: that is the only destination a Meta ad can have."><textarea name="primaryText" required rows={4} maxLength={500} className={textareaClass} /></Field></div>
        </>
      ) : (
        <>
          <div className="sm:col-span-4"><Field label="Landing page version id" hint="A Google ad points at a landing page version, never at a bare website."><input name="landingPageVersionId" required className={inputClass} /></Field></div>
          <div className="sm:col-span-2"><Field label="Keywords" hint="One per line: text | exact, phrase or broad. At least three."><textarea name="keywords" required rows={5} className={textareaClass} /></Field></div>
          <div className="sm:col-span-2"><Field label="Negative keywords" hint="One per line. Required."><textarea name="negatives" required rows={5} className={textareaClass} /></Field></div>
          <div className="sm:col-span-2"><Field label="Headlines" hint="One per line, 3 to 15, each up to 30 characters."><textarea name="headlines" required rows={5} className={textareaClass} /></Field></div>
          <div className="sm:col-span-2"><Field label="Descriptions" hint="One per line, 2 to 4, each up to 90 characters."><textarea name="descriptions" required rows={5} className={textareaClass} /></Field></div>
        </>
      )}
      <div className="flex items-center gap-3 sm:col-span-4">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>{campaignId ? 'Save as the next version' : 'Save campaign draft'}</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

function OneButton({ versionId, action: act, label, variant = 'secondary' }: { versionId: string; action: typeof checkAdVersionAction; label: string; variant?: 'primary' | 'secondary' }) {
  const [state, run, pending] = useActionState(act, IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-1">
      <input type="hidden" name="versionId" value={versionId} />
      <button type="submit" disabled={pending} className={buttonClass(variant)}>{label}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export const CheckAdButton = ({ versionId }: { versionId: string }) => <OneButton versionId={versionId} action={checkAdVersionAction} label="Run the checks" />;
export const SubmitAdButton = ({ versionId }: { versionId: string }) => <OneButton versionId={versionId} action={submitAdVersionAction} label="Send for approval" variant="primary" />;

export function AdChangeForm({ campaignId, action: what }: { campaignId: string; action: 'pause' | 'resume' | 'end' }) {
  const [state, run, pending] = useActionState(requestAdChangeAction, IDLE_STATE);
  const label = what === 'pause' ? 'Pause' : what === 'resume' ? 'Resume' : 'End';
  return (
    <form action={run} className="flex flex-col gap-1">
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="action" value={what} />
      <div className="flex items-end gap-2">
        <Field label={`${label} - why?`}><input name="reason" required minLength={3} maxLength={300} className={inputClass} /></Field>
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>{label}</button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
