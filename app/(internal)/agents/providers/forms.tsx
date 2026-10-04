'use client';

import { useActionState } from 'react';

import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

import {
  addKeyAction,
  archiveProviderAction,
  clearAssignmentAction,
  deleteProviderAction,
  refreshModelsAction,
  registerModelAction,
  removeKeyAction,
  rotateKeyAction,
  saveProviderAction,
  setAssignmentAction,
  setKeyStateAction,
  setModelEnabledAction,
  setProviderEnabledAction,
  setRoutingModeAction,
  testProviderAction,
} from './actions';

/**
 * The Provider Manager's controls. Each is a form over a server action; every control is drawn for the role that may use it and the
 * doors refuse everyone else, the refusal shown as written. A key is typed into a password field, sent once and never returned: no
 * field here is ever pre-filled with a stored key.
 */

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

function useForm(action: Action) {
  return useActionState(action, IDLE_STATE);
}

/** One button that posts hidden fields - for the "do this now" controls. */
function ButtonForm({ action, fields, label, busy, tone = 'secondary' }: { action: Action; fields: Record<string, string>; label: string; busy?: string; tone?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const [state, run, pending] = useForm(action);
  return (
    <form action={run} className="flex flex-wrap items-center gap-2">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" disabled={pending} className={buttonClass(tone, 'sm')}>
        {pending ? (busy ?? '…') : label}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function TestConnectionButton({ providerId, keyId, label = 'Test connection' }: { providerId: string; keyId?: string; label?: string }) {
  return <ButtonForm action={testProviderAction} fields={{ providerId, keyId: keyId ?? '' }} label={label} busy="Testing…" />;
}

export function RefreshModelsButton({ providerId }: { providerId: string }) {
  return <ButtonForm action={refreshModelsAction} fields={{ providerId }} label="Refresh models" busy="Asking the provider…" />;
}

export function ProviderStateForm({ providerId, enabled }: { providerId: string; enabled: boolean }) {
  const [state, run, pending] = useForm(setProviderEnabledAction);
  return (
    <form action={run} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      {enabled ? <input name="reason" required maxLength={300} placeholder="why turn it off" aria-label="Reason for disabling" className={`${inputClass} h-8 w-52 text-xs`} /> : null}
      <button type="submit" disabled={pending} className={buttonClass(enabled ? 'secondary' : 'primary', 'sm')}>
        {pending ? '…' : enabled ? 'Disable provider' : 'Enable provider'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function ArchiveProviderForm({ providerId }: { providerId: string }) {
  return <ButtonForm action={archiveProviderAction} fields={{ providerId }} label="Archive" tone="ghost" />;
}

export function DeleteProviderForm({ providerId }: { providerId: string }) {
  const [state, run, pending] = useForm(deleteProviderAction);
  return (
    <form action={run} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="providerId" value={providerId} />
      <input name="confirm" required placeholder={`type ${providerId}`} aria-label="Type the provider id to confirm" className={`${inputClass} h-8 w-44 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
        {pending ? '…' : 'Delete provider'}
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full text-xs" />
    </form>
  );
}

export type ProviderDraft = {
  providerId?: string;
  kind?: string;
  displayName?: string;
  baseUrl?: string;
  authScheme?: string;
  matchPrefixes?: string[];
  matchContains?: string[];
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  retryMax?: number;
  modelsPath?: string;
  apiVersion?: string | null;
  priority?: number;
};

/** Add a custom provider, or edit one (the id is then fixed). */
export function ProviderForm({ draft, editing }: { draft?: ProviderDraft; editing?: boolean }) {
  const [state, run, pending] = useForm(saveProviderAction);
  const d = draft ?? {};
  return (
    <form action={run} className="flex flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Provider id</span>
          <input name="providerId" required readOnly={editing} defaultValue={d.providerId} pattern="[a-z][a-z0-9_-]{1,39}" placeholder="acme-gateway" className={`${inputClass} font-mono text-xs`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Display name</span>
          <input name="displayName" required maxLength={80} defaultValue={d.displayName} placeholder="Acme Gateway" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Speaks</span>
          <select name="kind" defaultValue={d.kind ?? 'openai_compat'} className={selectClass}>
            <option value="openai_compat">OpenAI-compatible (chat completions)</option>
            <option value="anthropic_compat">Anthropic-compatible (messages)</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Base URL (https)</span>
          <input name="baseUrl" required defaultValue={d.baseUrl} placeholder="https://llm.example.com/v1" className={`${inputClass} font-mono text-xs`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Key is sent as</span>
          <select name="authScheme" defaultValue={d.authScheme ?? 'bearer'} className={selectClass}>
            <option value="bearer">Authorization: Bearer</option>
            <option value="x-api-key">x-api-key header</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Models list path</span>
          <input name="modelsPath" defaultValue={d.modelsPath ?? '/models'} className={`${inputClass} font-mono text-xs`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Model ids start with (comma-separated)</span>
          <input name="matchPrefixes" defaultValue={(d.matchPrefixes ?? []).join(', ')} placeholder="acme-" className={`${inputClass} font-mono text-xs`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>…or contain (comma-separated)</span>
          <input name="matchContains" defaultValue={(d.matchContains ?? []).join(', ')} className={`${inputClass} font-mono text-xs`} />
        </label>
      </div>
      <details className="rounded-lg border border-line px-3 py-2 text-[13px]">
        <summary className="cursor-pointer font-medium">Advanced</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Timeout (ms)</span>
            <input type="number" name="timeoutMs" min={1000} max={300000} defaultValue={d.timeoutMs ?? 60000} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Retries</span>
            <input type="number" name="retryMax" min={0} max={3} defaultValue={d.retryMax ?? 1} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Priority (lower first)</span>
            <input type="number" name="priority" min={1} max={1000} defaultValue={d.priority ?? 100} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>API version header</span>
            <input name="apiVersion" defaultValue={d.apiVersion ?? ''} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-4">
            <span className={labelClass}>Extra headers, one per line (never a credential)</span>
            <textarea name="extraHeaders" rows={2} defaultValue={Object.entries(d.extraHeaders ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')} className={`${inputClass} font-mono text-xs`} />
          </label>
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : editing ? 'Save provider' : 'Add provider'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

export function AddKeyForm({ providerId }: { providerId: string }) {
  const [state, run, pending] = useForm(addKeyAction);
  return (
    <form action={run} className="flex flex-col gap-2 border-t border-line px-4 py-4 sm:px-5">
      <input type="hidden" name="providerId" value={providerId} />
      <span className="text-[13px] font-semibold">Add a key</span>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Label</span>
          <input name="label" required maxLength={60} placeholder="production 1" className={`${inputClass} w-44`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Environment</span>
          <select name="environment" defaultValue="production" className={selectClass}>
            <option value="production">production</option>
            <option value="test">test</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Order (lower first)</span>
          <input type="number" name="priority" min={1} max={1000} defaultValue={100} className={`${inputClass} w-24`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>API key</span>
          <input type="password" name="secret" required autoComplete="off" spellCheck={false} placeholder="paste once - never shown again" className={`${inputClass} w-72 font-mono text-xs`} />
        </label>
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Encrypting…' : 'Store key'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function KeyActions({ providerId, keyId, enabled }: { providerId: string; keyId: string; enabled: boolean }) {
  const [rotateState, rotate, rotating] = useForm(rotateKeyAction);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <TestConnectionButton providerId={providerId} keyId={keyId} label="Test" />
        <ButtonForm action={setKeyStateAction} fields={{ providerId, keyId, enabled: enabled ? 'false' : 'true' }} label={enabled ? 'Disable' : 'Enable'} tone="ghost" />
        <ButtonForm action={removeKeyAction} fields={{ providerId, keyId }} label="Remove" tone="ghost" />
      </div>
      <form action={rotate} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="providerId" value={providerId} />
        <input type="hidden" name="keyId" value={keyId} />
        <input type="password" name="secret" required autoComplete="off" placeholder="new key value" aria-label="New key value" className={`${inputClass} h-8 w-56 font-mono text-xs`} />
        <button type="submit" disabled={rotating} className={buttonClass('secondary', 'sm')}>
          {rotating ? '…' : 'Rotate'}
        </button>
        <FormMessage status={rotateState.status} message={rotateState.message} className="text-xs" />
      </form>
    </div>
  );
}

export function ModelToggle({ providerId, modelId, enabled }: { providerId: string; modelId: string; enabled: boolean }) {
  return <ButtonForm action={setModelEnabledAction} fields={{ providerId, modelId, enabled: enabled ? 'false' : 'true' }} label={enabled ? 'Disable' : 'Enable'} tone={enabled ? 'ghost' : 'secondary'} />;
}

export function RegisterModelForm({ providerId }: { providerId: string }) {
  const [state, run, pending] = useForm(registerModelAction);
  return (
    <form action={run} className="flex flex-col gap-2 border-t border-line px-4 py-4 sm:px-5">
      <input type="hidden" name="providerId" value={providerId} />
      <span className="text-[13px] font-semibold">Register a model by hand</span>
      <p className="text-xs text-muted">For a provider that does not list its models, or a model it does not list. It arrives disabled.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Model id</span>
          <input name="modelId" required maxLength={200} className={`${inputClass} w-56 font-mono text-xs`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Display name</span>
          <input name="displayName" maxLength={120} className={`${inputClass} w-44`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Context tokens</span>
          <input type="number" name="contextTokens" min={1} className={`${inputClass} w-28`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Tool calling</span>
          <select name="toolCalling" defaultValue="unknown" className={selectClass}>
            <option value="unknown">unknown</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Structured output</span>
          <select name="structuredOutput" defaultValue="unknown" className={selectClass}>
            <option value="unknown">unknown</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </label>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Registering…' : 'Register'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

/** The mode switch. Changing it affects every agent, so it asks for a reason and says what will happen. */
export function RoutingModeForm({ mode }: { mode: 'auto' | 'manual' }) {
  const [state, run, pending] = useForm(setRoutingModeAction);
  const next = mode === 'auto' ? 'manual' : 'auto';
  return (
    <form action={run} className="flex flex-col gap-2 px-4 py-4 sm:px-5">
      <input type="hidden" name="mode" value={next} />
      <p className="text-[13px] text-muted">
        {mode === 'auto'
          ? 'Switching to MANUAL makes every agent run exactly on the provider and model you assign it. Nothing is substituted: if an assignment cannot run, the run is blocked and you are alerted. Agents without an assignment are blocked too.'
          : 'Switching to AUTO lets the orchestrator choose among the providers and models you enabled. Your manual assignments are kept and come back if you switch to MANUAL again.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input name="reason" required maxLength={500} placeholder={`why switch to ${next.toUpperCase()}`} aria-label="Reason for the change" className={`${inputClass} h-8 w-72 text-xs`} />
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? '…' : `Switch to ${next.toUpperCase()}`}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

export type TargetOption = { value: string; label: string };

/** One agent's manual assignment: provider+model, up to three explicit fallbacks. Options come from the registry, never a fixed list. */
export function AssignmentForm({
  agentKey,
  options,
  primary,
  fallbacks,
  note,
}: {
  agentKey: string;
  options: readonly TargetOption[];
  primary: string;
  fallbacks: readonly string[];
  note: string;
}) {
  const [state, run, pending] = useForm(setAssignmentAction);
  const [clearState, clear, clearing] = useForm(clearAssignmentAction);
  const choose = (name: string, value: string, required: boolean, label: string) => (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      <select name={name} defaultValue={value} required={required} className={`${selectClass} w-64 font-mono text-xs`}>
        <option value="">{required ? 'Choose…' : 'none'}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="flex flex-col gap-2">
      <form action={run} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="agentKey" value={agentKey} />
        {choose('primary', primary, true, 'Provider · model')}
        {choose('fallback1', fallbacks[0] ?? '', false, 'Fallback 1')}
        {choose('fallback2', fallbacks[1] ?? '', false, 'Fallback 2')}
        {choose('fallback3', fallbacks[2] ?? '', false, 'Fallback 3')}
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Note</span>
          <input name="note" maxLength={300} defaultValue={note} className={`${inputClass} w-44`} />
        </label>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </form>
      {primary ? (
        <form action={clear} className="flex items-center gap-2">
          <input type="hidden" name="agentKey" value={agentKey} />
          <button type="submit" disabled={clearing} className={buttonClass('ghost', 'sm')}>
            Clear assignment
          </button>
          <FormMessage status={clearState.status} message={clearState.message} className="text-xs" />
        </form>
      ) : null}
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </div>
  );
}
