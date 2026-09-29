'use client';

import { useActionState } from 'react';

import { PROVIDER_IDS } from '@/lib/ai/model-provider';
import { addModelAction, retireModelAction, setFallbackChainAction, setProviderBudgetAction } from '@/modules/agents/models-actions';
import type { FallbackChainRow, ProviderBudgetRow } from '@/modules/agents/models-queries';
import { MODEL_CAPABILITIES } from '@/modules/agents/models-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-064 — Decision 2026-09-30: ADM-84 reversed, the owner manages models
 * in the panel. Three cards over the same registry: the models (add /
 * retire), the fallback chain per work class the runner consults after the
 * override and the policy, and the monthly cap per provider the runner
 * refuses past. Every control is drawn for the owner alone; the doors refuse
 * everyone else and the refusal is shown as written.
 */

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export function AddModelForm() {
  const [state, action, pending] = useActionState(addModelAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line px-4 py-4 sm:px-5">
      <span className="text-[13px] font-semibold">Add a model</span>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Model id</span>
          <input name="modelId" required maxLength={120} placeholder="claude-sonnet-5" className={`${inputClass} w-56 font-mono text-xs`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Provider</span>
          <select name="provider" defaultValue="anthropic" className={selectClass}>
            {PROVIDER_IDS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Context tokens</span>
          <input type="number" name="contextTokens" min={1} step={1} placeholder="optional" className={`${inputClass} w-32`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>₹ / Mtok in</span>
          <input type="number" name="inputCostRupeesPerMtok" min={0} step={0.01} placeholder="optional" className={`${inputClass} w-28`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>₹ / Mtok out</span>
          <input type="number" name="outputCostRupeesPerMtok" min={0} step={0.01} placeholder="optional" className={`${inputClass} w-28`} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className={labelClass}>Capabilities</span>
        {MODEL_CAPABILITIES.map((c) => (
          <label key={c} className="flex items-center gap-1">
            <input type="checkbox" name="capabilities" value={c} />
            {c.replace('_', ' ')}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Adding…' : 'Add model'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

export function RetireModelForm({ modelId }: { modelId: string }) {
  const [state, action, pending] = useActionState(retireModelAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-1">
      <input type="hidden" name="modelId" value={modelId} />
      <input name="reason" required maxLength={500} placeholder="why retire" aria-label={`Reason for retiring ${modelId}`} className={`${inputClass} h-7 w-36 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? '…' : 'Retire'}
      </button>
      {state.status === 'error' ? <span className="basis-full text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

function FallbackChainForm({ row, available }: { row: FallbackChainRow; available: string[] }) {
  const [state, action, pending] = useActionState(setFallbackChainAction, IDLE_STATE);
  const listId = `models-for-${row.workClass}`;

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="workClass" value={row.workClass} />
      <input
        name="modelIds"
        defaultValue={row.modelIds.join(', ')}
        list={listId}
        placeholder="model ids, in order, comma-separated"
        aria-label={`Fallback chain for ${row.workClass} work`}
        className={`${inputClass} h-8 w-72 font-mono text-xs`}
      />
      <datalist id={listId}>
        {available.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Save chain'}
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full text-xs" />
    </form>
  );
}

export function FallbackChainsPanel({ chains, available, editable }: { chains: FallbackChainRow[]; available: string[]; editable: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {chains.map((row) => (
        <li key={row.workClass} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-medium">{row.workClass.replace('_', ' ')}</span>
            {row.modelIds.length === 0 ? (
              <Badge tone="neutral">none set — straight to the agent default</Badge>
            ) : (
              row.modelIds.map((m, i) => (
                <Badge key={m} tone="info" mono>
                  {i + 1}. {m}
                </Badge>
              ))
            )}
          </span>
          {editable ? <FallbackChainForm row={row} available={available} /> : null}
        </li>
      ))}
    </ul>
  );
}

function ProviderBudgetForm({ row }: { row: ProviderBudgetRow }) {
  const [state, action, pending] = useActionState(setProviderBudgetAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="provider" value={row.provider} />
      <input
        type="number"
        name="monthlyCapRupees"
        min={0}
        step={0.01}
        defaultValue={row.monthlyCapMinor === null ? '' : (row.monthlyCapMinor / 100).toFixed(2)}
        placeholder="₹ per month · 0 clears"
        aria-label={`Monthly cap for ${row.provider}`}
        className={`${inputClass} h-8 w-40 text-xs`}
      />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Set cap'}
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full text-xs" />
    </form>
  );
}

export function ProviderBudgetsPanel({ budgets, editable }: { budgets: ProviderBudgetRow[]; editable: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {budgets.map((row) => {
        const over = row.monthlyCapMinor !== null && row.spentMinor !== null && row.spentMinor >= row.monthlyCapMinor;
        const share = row.monthlyCapMinor !== null && row.spentMinor !== null && row.monthlyCapMinor > 0 ? Math.min(100, Math.round((row.spentMinor / row.monthlyCapMinor) * 100)) : null;
        return (
          <li key={row.provider} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-medium">{row.provider}</span>
              {row.monthlyCapMinor === null ? (
                <Badge tone="neutral">no cap</Badge>
              ) : (
                <>
                  <span className="tabular text-muted">
                    {INR.format((row.spentMinor ?? 0) / 100)} of {INR.format(row.monthlyCapMinor / 100)} this month
                    {share !== null ? ` · ${share}%` : ''}
                  </span>
                  <Badge tone={over ? 'danger' : share !== null && share >= 80 ? 'warning' : 'success'} dot>
                    {over ? 'over budget — calls refused' : 'within budget'}
                  </Badge>
                </>
              )}
            </span>
            {editable ? <ProviderBudgetForm row={row} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
