'use client';

import { useActionState } from 'react';

import {
  approveCampaignAction,
  approveTemplateAction,
  convertProspectAction,
  createCampaignAction,
  createTemplateAction,
  importProspectsAction,
  markRepliedAction,
  saveOutreachSettingsAction,
  setCampaignStateAction,
  suppressAction,
} from '@/modules/crm/outreach/actions';
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

export function SettingsForm({
  initial,
  isOwner,
}: {
  initial: { senderName: string; postalAddress: string; replyTo: string; dailyCap: number; bouncePausePercent: number; coldBasisEnabled: boolean };
  isOwner: boolean;
}) {
  const [state, action, pending] = useActionState(saveOutreachSettingsAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <Field label="Sender name" hint="Printed in every email: who is writing.">
        <input name="senderName" defaultValue={initial.senderName} required maxLength={120} className={inputClass} />
      </Field>
      <Field label="Reply-to address (optional)" hint="Where replies and “unsubscribe” mails should go.">
        <input name="replyTo" type="email" defaultValue={initial.replyTo} className={inputClass} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Postal address" hint="Printed in every email. A commercial email must say where its sender is.">
          <input name="postalAddress" defaultValue={initial.postalAddress} required minLength={8} maxLength={400} className={inputClass} />
        </Field>
      </div>
      <Field label="Emails per day (cap)" hint="A new mailbox warms up: 10 on the first day, +5 a day, never above this.">
        <input name="dailyCap" type="number" min={1} max={500} defaultValue={initial.dailyCap} className={inputClass} />
      </Field>
      <Field label="Pause a campaign at this bounce rate (%)" hint="Measured over the last 7 days, once at least 20 have been sent.">
        <input name="bouncePausePercent" type="number" min={1} max={50} step="0.5" defaultValue={initial.bouncePausePercent} className={inputClass} />
      </Field>
      {isOwner ? (
        <div className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning-soft p-3 sm:col-span-2">
          <input type="hidden" name="coldBasisPresent" value="1" />
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" name="coldBasisEnabled" defaultChecked={initial.coldBasisEnabled} className="mt-1" />
            <span>
              <strong>Allow cold business outreach</strong> to people who have not given email consent (a public business address, “legitimate interest”).
              Off, only people with recorded email consent are emailed - the rule in ADM-70/81. Turning this on is a legal position that only the owner can take;
              get advice for the countries you email into. Every email still carries your identity and a working unsubscribe link, and anyone who unsubscribes is never emailed again.
            </span>
          </label>
        </div>
      ) : (
        <p className="text-xs text-muted sm:col-span-2">Cold business outreach is {initial.coldBasisEnabled ? 'ON' : 'OFF'}. Only the owner can change it.</p>
      )}
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save settings'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

export function ImportForm() {
  const [state, action, pending] = useActionState(importProspectsAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label="People (CSV, with a header row)" hint="Columns: email (required), name, company, title, website, language (en / hinglish / hindi), tags (separate with ;), provenance, basis.">
        <textarea name="csv" required rows={6} className={textareaClass} placeholder={'email,name,company,tags\nasha@example.com,Asha Rao,Rao Pharmacy,pharmacy;delhi'} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="How were these addresses obtained?" hint="Required for the whole list unless a provenance column says it per person. An address nobody can account for is not emailed.">
          <input name="provenance" required minLength={3} maxLength={300} className={inputClass} placeholder="e.g. Business directory listing, checked 4 Oct 2026" />
        </Field>
        <Field label="Lawful basis" hint="Consent and existing relationship need a contact the system already knows, with granted email consent. Business listing needs the owner's switch.">
          <select aria-label="Lawful basis" name="lawfulBasis" defaultValue="b2b_legitimate_interest" className={selectClass}>
            <option value="b2b_legitimate_interest">Public business address (needs the owner's switch)</option>
            <option value="consent">They agreed to hear from us (known contact)</option>
            <option value="existing_relationship">An existing client or lead (known contact)</option>
          </select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Importing…' : 'Add to the prospect list'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

export function TemplateForm() {
  const [state, action, pending] = useActionState(createTemplateAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name (internal)">
          <input name="name" required maxLength={120} className={inputClass} />
        </Field>
        <Field label="Language">
          <select aria-label="Language" name="language" defaultValue="en" className={selectClass}>
            <option value="en">English</option>
            <option value="hinglish">Hinglish</option>
            <option value="hindi">Hindi</option>
          </select>
        </Field>
        <Field label="Subject" hint="You may use {{first_name}} and {{company}}.">
          <input name="subject" required minLength={3} maxLength={200} className={inputClass} />
        </Field>
      </div>
      <Field label="Message" hint="Only the message. The sender identity, the reason they are receiving it and the unsubscribe link are added for you. No prices, discounts or guarantees; no mention of AI tooling.">
        <textarea name="body" required minLength={20} rows={7} className={textareaClass} placeholder={'Hi {{first_name}},\n\nI noticed {{company}} ...'} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save draft'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

export function ApproveTemplateForm({ templateId }: { templateId: string }) {
  const [state, action, pending] = useActionState(approveTemplateAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="templateId" value={templateId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Approving…' : 'Approve'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function CampaignForm({ templates }: { templates: { id: string; name: string; language: string }[] }) {
  const [state, action, pending] = useActionState(createCampaignAction, IDLE_STATE);
  if (templates.length === 0) return <p className="text-[13px] text-muted">Write and approve a template first - a campaign can only use approved wording.</p>;
  const options = (
    <>
      <option value="">— none —</option>
      {templates.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name} · {t.language}
        </option>
      ))}
    </>
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Campaign name">
          <input name="name" required maxLength={120} className={inputClass} />
        </Field>
        <Field label="Only these tags (optional)" hint="Comma separated. Blank means everyone with status “new”.">
          <input name="tags" className={inputClass} />
        </Field>
        <Field label="Only these languages (optional)" hint="en, hinglish, hindi">
          <input name="languages" className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Step 1 (sent at once)">
          <select aria-label="Step 1 template" name="template1" required className={selectClass} defaultValue="">
            {options}
          </select>
        </Field>
        <Field label="Step 2 follow-up (optional)">
          <div className="flex gap-2">
            <select aria-label="Step 2 template" name="template2" className={selectClass} defaultValue="">
              {options}
            </select>
            <input name="delay2" type="number" min={1} max={30} defaultValue={3} className={`${inputClass} w-20`} aria-label="Days after step 1" title="Days after step 1" />
          </div>
        </Field>
        <Field label="Step 3 follow-up (optional)">
          <div className="flex gap-2">
            <select aria-label="Step 3 template" name="template3" className={selectClass} defaultValue="">
              {options}
            </select>
            <input name="delay3" type="number" min={1} max={30} defaultValue={5} className={`${inputClass} w-20`} aria-label="Days after step 2" title="Days after step 2" />
          </div>
        </Field>
      </div>
      <Field label="Limit (optional)" hint="At most this many people.">
        <input name="limit" type="number" min={1} max={2000} className={`${inputClass} w-32`} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Creating…' : 'Create draft'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

export function CampaignControls({ campaignId, status }: { campaignId: string; status: string }) {
  const [approveState, approve, approving] = useActionState(approveCampaignAction, IDLE_STATE);
  const [stateState, change, changing] = useActionState(setCampaignStateAction, IDLE_STATE);
  return (
    <div className="flex flex-col gap-3">
      {status === 'draft' ? (
        <form action={approve} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="campaignId" value={campaignId} />
          <button type="submit" disabled={approving} className={buttonClass('primary', 'sm')}>
            {approving ? 'Approving…' : 'Approve and freeze the audience'}
          </button>
          <span className="text-xs text-muted">A second person from the one who wrote it. Approving fixes exactly who it goes to.</span>
          <FormMessage status={approveState.status} message={approveState.message} className="text-xs" />
        </form>
      ) : null}
      {['approved', 'running', 'paused'].includes(status) ? (
        <form action={change} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="campaignId" value={campaignId} />
          <input name="note" placeholder={status === 'paused' ? 'Why is it safe to resume?' : 'Note (optional)'} className={`${inputClass} min-w-[14rem] flex-1`} />
          {status !== 'running' ? (
            <button type="submit" name="to" value="running" disabled={changing} className={buttonClass('primary', 'sm')}>
              {status === 'paused' ? 'Resume' : 'Start sending'}
            </button>
          ) : (
            <button type="submit" name="to" value="paused" disabled={changing} className={buttonClass('secondary', 'sm')}>
              Pause
            </button>
          )}
          <button type="submit" name="to" value="cancelled" disabled={changing} className={buttonClass('danger', 'sm')}>
            Cancel
          </button>
          <FormMessage status={stateState.status} message={stateState.message} className="text-xs" />
        </form>
      ) : null}
    </div>
  );
}

export function SuppressForm() {
  const [state, action, pending] = useActionState(suppressAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <Field label="Address">
        <input name="email" type="email" required className={inputClass} />
      </Field>
      <Field label="Why">
        <select aria-label="Why this address is suppressed" name="reason" defaultValue="manual" className={selectClass}>
          <option value="manual">Asked us to stop</option>
          <option value="complaint">Complained</option>
          <option value="hard_bounce">Bounced (delivery failed for good)</option>
          <option value="erasure">Asked for their data to be erased</option>
        </select>
      </Field>
      <Field label="Note (optional)">
        <input name="note" maxLength={300} className={inputClass} />
      </Field>
      <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
        {pending ? 'Saving…' : 'Never email again'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function ProspectActions({ prospectId, status, leadId }: { prospectId: string; status: string; leadId: string | null }) {
  const [repliedState, replied, marking] = useActionState(markRepliedAction, IDLE_STATE);
  const [convertState, convert, converting] = useActionState(convertProspectAction, IDLE_STATE);
  if (['converted', 'do_not_contact'].includes(status) || leadId) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {status !== 'replied' ? (
        <form action={replied}>
          <input type="hidden" name="prospectId" value={prospectId} />
          <button type="submit" disabled={marking} className={buttonClass('secondary', 'sm')}>
            Replied
          </button>
        </form>
      ) : null}
      <form action={convert}>
        <input type="hidden" name="prospectId" value={prospectId} />
        <button type="submit" disabled={converting} className={buttonClass('secondary', 'sm')}>
          Make a lead
        </button>
      </form>
      <FormMessage status={repliedState.status === 'idle' ? convertState.status : repliedState.status} message={repliedState.message ?? convertState.message} className="text-xs" />
    </div>
  );
}
