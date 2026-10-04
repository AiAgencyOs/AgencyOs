'use client';

import { useActionState } from 'react';

import {
  checkProfileAction, checkProposalAction, decideOpportunityAction, linkLeadAction, importOpportunityAction, readyB2bAction, recordOutcomeAction, recordProfileAppliedAction, recordSentAction,
  saveB2bRuleAction, saveB2bSettingsAction, saveProfileAction, saveProposalAction, submitProfileAction, submitProposalAction,
} from '@/modules/acquisition/actions';
import { AUTOMATION_LABEL, AUTOMATION_ORDER, B2B_PLATFORMS, B2B_PLATFORM_LABEL, OFFPLATFORM_LABEL, OFFPLATFORM_ORDER } from '@/modules/acquisition/b2b-vocabulary';
import { IDLE_STATE, type FormState } from '@/modules/identity/types';
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

export function SetupB2bButton() {
  const [state, run, pending] = useActionState(async () => readyB2bAction(), IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-1">
      <button type="submit" disabled={pending} className={buttonClass('primary')}>Set up B2B</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function RuleForm({ platform, offplatform, mode, note }: { platform: string; offplatform: string; mode: string; note: string | null }) {
  const [state, run, pending] = useActionState(saveB2bRuleAction, IDLE_STATE);
  return (
    <form action={run} className="grid items-end gap-2 sm:grid-cols-5">
      <input type="hidden" name="platform" value={platform} />
      <span className="text-[13px] font-medium">{B2B_PLATFORM_LABEL[platform as keyof typeof B2B_PLATFORM_LABEL] ?? platform}</span>
      <Field label="Contact off the platform"><select name="offplatform" aria-label={`${platform} off-platform contact`} defaultValue={offplatform} className={selectClass}>{OFFPLATFORM_ORDER.map((o) => <option key={o} value={o}>{OFFPLATFORM_LABEL[o]}</option>)}</select></Field>
      <Field label="Automation"><select name="mode" aria-label={`${platform} automation`} defaultValue={mode} className={selectClass}>{AUTOMATION_ORDER.map((m) => <option key={m} value={m}>{AUTOMATION_LABEL[m]}</option>)}</select></Field>
      <Field label="Note"><input name="note" defaultValue={note ?? ''} maxLength={500} className={inputClass} /></Field>
      <div className="flex flex-col gap-1"><button type="submit" disabled={pending} className={buttonClass('secondary')}>Save</button><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

export function B2bSettingsForm({ minBudgetMajor, excluded, threshold, cap }: { minBudgetMajor: number | null; excluded: string[]; threshold: number; cap: number | null }) {
  const [state, run, pending] = useActionState(saveB2bSettingsAction, IDLE_STATE);
  return (
    <form action={run} className="grid gap-3 sm:grid-cols-4">
      <Field label="Smallest job worth a proposal ($ or ₹)" hint="Leave empty for no minimum."><input name="minBudget" defaultValue={minBudgetMajor ?? ''} inputMode="decimal" className={inputClass} /></Field>
      <Field label="Score that makes a job worth a look" hint="0 to 100."><input name="threshold" required defaultValue={threshold} inputMode="numeric" className={inputClass} /></Field>
      <Field label="Connects budget a month" hint="Empty means no budget set."><input name="connectsCap" defaultValue={cap ?? ''} inputMode="numeric" className={inputClass} /></Field>
      <div className="sm:col-span-4"><Field label="Excluded words" hint="Commas. A job that mentions one is excluded and cannot be shortlisted."><input name="excluded" defaultValue={excluded.join(', ')} className={inputClass} /></Field></div>
      <div className="flex items-center gap-3 sm:col-span-4"><button type="submit" disabled={pending} className={buttonClass('primary')}>Save</button><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

export function ImportOpportunityForm() {
  const [state, run, pending] = useActionState(importOpportunityAction, IDLE_STATE);
  return (
    <form action={run} className="grid gap-3 sm:grid-cols-4">
      <Field label="Marketplace"><select name="platform" aria-label="Marketplace" className={selectClass}>{B2B_PLATFORMS.map((p) => <option key={p} value={p}>{B2B_PLATFORM_LABEL[p]}</option>)}</select></Field>
      <Field label="The platform's own job id"><input name="externalRef" required maxLength={200} className={inputClass} /></Field>
      <div className="sm:col-span-2"><Field label="Link"><input name="url" type="url" className={inputClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="Title"><input name="title" required minLength={3} maxLength={300} className={inputClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="What the client wrote" hint="Paste it as it appears. It is kept exactly and cannot be edited later."><textarea name="description" rows={5} className={textareaClass} /></Field></div>
      <Field label="Budget from"><input name="budgetMin" inputMode="decimal" className={inputClass} /></Field>
      <Field label="Budget to"><input name="budgetMax" inputMode="decimal" className={inputClass} /></Field>
      <Field label="Currency"><input name="currency" defaultValue="USD" maxLength={3} className={inputClass} /></Field>
      <Field label="Client country"><input name="country" maxLength={60} className={inputClass} /></Field>
      <div className="flex items-center gap-3 sm:col-span-4"><button type="submit" disabled={pending} className={buttonClass('primary')}>Record and score</button><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

function Mini({ action, hidden, fields, label, variant = 'secondary' }: { action: (p: FormState, f: FormData) => Promise<FormState>; hidden: Record<string, string>; fields?: React.ReactNode; label: string; variant?: 'primary' | 'secondary' }) {
  const [state, run, pending] = useActionState(action, IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-1">
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <div className="flex items-end gap-2">{fields}<button type="submit" disabled={pending} className={buttonClass(variant)}>{label}</button></div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export const ShortlistButton = ({ opportunityId }: { opportunityId: string }) => <Mini action={decideOpportunityAction} hidden={{ opportunityId, decision: 'shortlist', reason: '' }} label="Shortlist" variant="primary" />;
export const SkipForm = ({ opportunityId }: { opportunityId: string }) => <Mini action={decideOpportunityAction} hidden={{ opportunityId, decision: 'skip' }} label="Skip" fields={<Field label="Why skip?"><input name="reason" required minLength={3} maxLength={300} className={inputClass} /></Field>} />;
export const CheckProposalButton = ({ versionId }: { versionId: string }) => <Mini action={checkProposalAction} hidden={{ versionId }} label="Run the checks" />;
export const SubmitProposalButton = ({ versionId }: { versionId: string }) => <Mini action={submitProposalAction} hidden={{ versionId }} label="Send for approval" variant="primary" />;
export const RecordSentForm = ({ versionId }: { versionId: string }) => <Mini action={recordSentAction} hidden={{ versionId }} label="I sent it - record it" variant="primary" fields={<Field label="The platform's reference for the proposal"><input name="externalRef" required maxLength={200} className={inputClass} /></Field>} />;
export const CheckProfileButton = ({ versionId }: { versionId: string }) => <Mini action={checkProfileAction} hidden={{ versionId }} label="Run the checks" />;
export const SubmitProfileButton = ({ versionId }: { versionId: string }) => <Mini action={submitProfileAction} hidden={{ versionId }} label="Send for approval" variant="primary" />;
export const RecordProfileAppliedForm = ({ versionId }: { versionId: string }) => <Mini action={recordProfileAppliedAction} hidden={{ versionId }} label="I changed it - record it" variant="primary" fields={<Field label="Link to your profile (https)"><input name="evidenceUrl" required type="url" className={inputClass} /></Field>} />;

export function OutcomeForm({ opportunityId }: { opportunityId: string }) {
  const [state, run, pending] = useActionState(recordOutcomeAction, IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-1">
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Outcome"><select name="outcome" aria-label="Outcome" className={selectClass}><option value="won">Won</option><option value="lost">Lost</option></select></Field>
        <Field label="Value if won"><input name="value" inputMode="decimal" className={inputClass} /></Field>
        <Field label="Note"><input name="note" maxLength={500} className={inputClass} /></Field>
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>Record</button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ProposalForm({ opportunityId, portfolio }: { opportunityId: string; portfolio: { id: string; title: string }[] }) {
  const [state, run, pending] = useActionState(saveProposalAction, IDLE_STATE);
  return (
    <form action={run} className="grid gap-3 sm:grid-cols-4">
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <div className="sm:col-span-4"><Field label="The proposal" hint="This exact text is what is checked, approved and sent. Where the marketplace forbids it, no email, phone, messaging app or link may appear."><textarea name="body" required rows={7} className={textareaClass} /></Field></div>
      <Field label="Your price" hint="Set by a person. Never by an agent."><input name="price" required inputMode="decimal" className={inputClass} /></Field>
      <Field label="Timeline (days)"><input name="timeline" required inputMode="numeric" className={inputClass} /></Field>
      <Field label="Connects it costs"><input name="connects" defaultValue="0" inputMode="numeric" className={inputClass} /></Field>
      <Field label="Past work (ids)" hint={portfolio.length > 0 ? portfolio.map((p) => `${p.id.slice(0, 8)} ${p.title}`).join(' · ') : 'No portfolio items yet.'}><input name="portfolio" className={inputClass} placeholder="full ids, separated by commas" /></Field>
      <div className="flex items-center gap-3 sm:col-span-4"><button type="submit" disabled={pending} className={buttonClass('primary')}>Save as a draft version</button><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

export function ProfileForm() {
  const [state, run, pending] = useActionState(saveProfileAction, IDLE_STATE);
  return (
    <form action={run} className="grid gap-3 sm:grid-cols-4">
      <Field label="Marketplace"><select name="platform" aria-label="Marketplace" className={selectClass}>{B2B_PLATFORMS.map((p) => <option key={p} value={p}>{B2B_PLATFORM_LABEL[p]}</option>)}</select></Field>
      <div className="sm:col-span-3"><Field label="Headline"><input name="headline" required maxLength={120} className={inputClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="Summary" hint="50 to 3,000 characters. Testimonials, reviews, ratings and badges cannot be written here."><textarea name="summary" required rows={5} className={textareaClass} /></Field></div>
      <div className="flex items-center gap-3 sm:col-span-4"><button type="submit" disabled={pending} className={buttonClass('primary')}>Save as a draft version</button><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

export const LinkLeadForm = ({ opportunityId }: { opportunityId: string }) => (
  <Mini action={linkLeadAction} hidden={{ opportunityId }} label="Link lead" fields={<Field label="Lead id this became" hint="Adds the marketplace as a touchpoint. Creates and merges nothing."><input name="leadId" required className={inputClass} /></Field>} />
);
