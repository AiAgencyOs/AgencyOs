'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import {
  addScreenAction,
  mapScreenScopeItemAction,
  mergeScreensAction,
  setScreenDesignStateAction,
  setScreenFigmaUrlAction,
  splitScreenAction,
  submitScreenForQaAction,
} from '@/modules/projects/screen-actions';
import { DESIGN_STATES } from '@/modules/projects/screen-schema';
import { buttonClass, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * SCR-032/034/035 — the forms over the screen inventory's doors
 * (`screen-actions.ts`). Each is rendered only while the page has read that
 * the screen list is open (no baseline, or a draft one); the database asks
 * again on every write and its refusal is shown verbatim below the form.
 */

export const DESIGN_STATE_LABEL: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  drawn: 'Drawn',
  reviewed: 'Reviewed',
};

function Message({ state }: { state: FormState }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex flex-col gap-1">
    <span className={labelClass}>{label}</span>
    {children}
  </label>
);

export type ScopeItemOption = { id: string; title: string; inclusion: string };

export function AddScreenForm({ projectId, scopeItems }: { projectId: string; scopeItems: ScopeItemOption[] }) {
  const [state, action, pending] = useActionState(addScreenAction, IDLE_STATE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className={buttonClass()} onClick={() => setOpen(true)}>
        Add screen
      </button>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Key">
          <input name="screenKey" required pattern="^[a-z][a-z0-9_.-]{1,62}$" placeholder="checkout_summary" className={inputClass} />
        </Field>
        <Field label="Name">
          <input name="name" required maxLength={200} placeholder="Checkout summary" className={inputClass} />
        </Field>
        <Field label="User role">
          <input name="userRole" required maxLength={100} placeholder="client" className={inputClass} />
        </Field>
      </div>
      <Field label="Purpose">
        <textarea name="purpose" rows={2} maxLength={2000} className={textareaClass} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Required sections (one per line)">
          <textarea name="requiredSections" rows={3} maxLength={4000} className={textareaClass} />
        </Field>
        <Field label="Actions">
          <textarea name="actions" rows={3} maxLength={2000} className={textareaClass} />
        </Field>
        <Field label="Required data">
          <textarea name="requiredData" rows={2} maxLength={2000} className={textareaClass} />
        </Field>
        <Field label="Dependencies">
          <textarea name="dependencies" rows={2} maxLength={2000} className={textareaClass} />
        </Field>
        <Field label="Entry point">
          <input name="entryPoint" maxLength={500} className={inputClass} />
        </Field>
        <Field label="Exit action">
          <input name="exitAction" maxLength={500} className={inputClass} />
        </Field>
      </div>
      <fieldset className="flex flex-wrap gap-4 text-[13px]">
        <legend className={labelClass}>States recorded</legend>
        {(['hasEmptyState', 'hasLoadingState', 'hasErrorState', 'hasSuccessState'] as const).map((n) => (
          <label key={n} className="flex items-center gap-1.5">
            <input type="checkbox" name={n} />
            {n.replace(/^has/, '').replace(/State$/, '').toLowerCase()}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-1 text-[13px]">
        <legend className={labelClass}>Covers (active scope)</legend>
        {scopeItems.length === 0 ? (
          <p className="text-muted">No active scope version — the screen can be added and mapped later.</p>
        ) : (
          <div className="grid gap-1 sm:grid-cols-2">
            {scopeItems.map((s) => (
              <label key={s.id} className="flex items-center gap-1.5">
                <input type="checkbox" name="scopeItemIds" value={s.id} />
                <span className="truncate">
                  {s.title}
                  {s.inclusion === 'optional' ? <span className="text-muted"> (optional)</span> : null}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass()}>
          Add screen
        </button>
        <button type="button" className={buttonClass('secondary')} onClick={() => setOpen(false)}>
          Close
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}

export const MERGE_FORM_ID = 'merge-screens';

/**
 * The rows' checkboxes belong to this form through `form={MERGE_FORM_ID}`,
 * so the selection is native — no client copy of the table.
 */
export function MergeScreensForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(mergeScreensAction, IDLE_STATE);

  return (
    <form id={MERGE_FORM_ID} action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
      <input type="hidden" name="projectId" value={projectId} />
      <p className="text-[13px] text-muted">
        Tick two or more rows, then name the screen that replaces them. The sources become superseded and keep their keys; their requirement mappings are united on the new screen.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="New key">
          <input name="screenKey" required pattern="^[a-z][a-z0-9_.-]{1,62}$" className={inputClass} />
        </Field>
        <Field label="New name">
          <input name="name" required maxLength={200} className={inputClass} />
        </Field>
        <Field label="User role (blank keeps the first source's)">
          <input name="userRole" maxLength={100} className={inputClass} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>
          Merge selected
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}

export function SplitScreenForm({ projectId, sourceId, sourceKey }: { projectId: string; sourceId: string; sourceKey: string }) {
  const [state, action, pending] = useActionState(splitScreenAction, IDLE_STATE);

  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer text-muted underline hover:text-foreground">Split</summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="sourceId" value={sourceId} />
        <Field label="Parts — one per line, key | name">
          <textarea name="parts" rows={3} required className={textareaClass} placeholder={`${sourceKey}_list | ${sourceKey} list\n${sourceKey}_detail | ${sourceKey} detail`} />
        </Field>
        <p className="text-xs text-muted">Every part inherits the role, the four states and every requirement mapping; unmap what a part does not cover afterwards.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={pending} className={buttonClass('secondary')}>
            Split into parts
          </button>
          <Message state={state} />
        </div>
      </form>
    </details>
  );
}

export function DesignStateForm({ projectId, screenId, current, compact = false }: { projectId: string; screenId: string; current: string; compact?: boolean }) {
  const [state, action, pending] = useActionState(setScreenDesignStateAction, IDLE_STATE);

  return (
    <form action={action} className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-2'}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="screenId" value={screenId} />
      <div className="flex items-center gap-1.5">
        <select
          name="designState"
          defaultValue={current}
          disabled={pending}
          aria-label="Design state"
          className={compact ? `${selectClass} !h-8 min-w-[9rem] !text-xs` : selectClass}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        >
          {DESIGN_STATES.map((s) => (
            <option key={s} value={s}>
              {DESIGN_STATE_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <Message state={state} />
    </form>
  );
}

export function FigmaUrlForm({ projectId, screenId, current }: { projectId: string; screenId: string; current: string | null }) {
  const [state, action, pending] = useActionState(setScreenFigmaUrlAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="screenId" value={screenId} />
      <Field label="Figma link (blank clears it)">
        <input name="figmaUrl" type="url" defaultValue={current ?? ''} placeholder="https://www.figma.com/design/…" maxLength={2000} className={inputClass} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>
          Save link
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}

export function MapScopeItemForm({ projectId, screenId, options }: { projectId: string; screenId: string; options: ScopeItemOption[] }) {
  const [state, action, pending] = useActionState(mapScreenScopeItemAction, IDLE_STATE);

  if (options.length === 0) {
    return <p className="text-[13px] text-muted">Every item of the active scope is already mapped, or there is no active scope version.</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="screenId" value={screenId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Map a requirement">
          <select name="scopeItemId" aria-label="Requirement to map" required className={`${selectClass} min-w-[16rem]`}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
                {o.inclusion === 'optional' ? ' (optional)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>
          Map
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function UnmapScopeItemForm({ projectId, screenId, scopeItemId }: { projectId: string; screenId: string; scopeItemId: string }) {
  const [state, action, pending] = useActionState(mapScreenScopeItemAction, IDLE_STATE);

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="screenId" value={screenId} />
      <input type="hidden" name="scopeItemId" value={scopeItemId} />
      <input type="hidden" name="remove" value="true" />
      <button type="submit" disabled={pending} className="text-xs text-muted underline hover:text-foreground">
        Unmap
      </button>
      <Message state={state} />
    </form>
  );
}

export function SubmitForQaForm({ projectId, screenId, submitted, hasDraftPlan }: { projectId: string; screenId: string; submitted: boolean; hasDraftPlan: boolean }) {
  const [state, action, pending] = useActionState(submitScreenForQaAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="screenId" value={screenId} />
      <p className="text-[13px] text-muted">
        {hasDraftPlan
          ? 'Marks the screen submitted and adds a UI test item to the draft test plan for every requirement it covers.'
          : 'Marks the screen submitted. This project has no draft test plan, so no test item is added — draft one under QA first if you want that.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending || submitted} className={buttonClass()}>
          {submitted ? 'Submitted for QA' : 'Submit for QA'}
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}
