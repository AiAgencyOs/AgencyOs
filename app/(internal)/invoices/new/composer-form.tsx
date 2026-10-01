'use client';

import Link from 'next/link';
import { useActionState, useId, useMemo, useState } from 'react';

import { composeInvoiceAction } from '@/modules/finance/actions';
import { composeLines, type ComposerLineInput } from '@/modules/finance/invoice-composer';
import { taxBreakdown } from '@/modules/finance/invoice-presentation';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, Callout, FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

import { ComposerReview, composerMoney as money, type ComposerProject } from './composer-review';

export type { ComposerProject };

const GST_RATE_BP = 1800;

type Line = ComposerLineInput & { id: number };

/**
 * The invoice composer — PDF SCR-052 "Invoice Detail / Create": composition
 * with tax mode, billing profile, line items, a tax calculation and a REVIEW
 * step before anything is written.
 *
 * Two steps, one form. Step 1 collects the project, dates and lines; step 2 is
 * the review — the lines as they will be stored, the tax by the project's
 * confirmed billing mode (and CGST / SGST / IGST by place of supply), the
 * billing profile the invoice will carry — and only its button writes, through
 * `composeInvoiceAction` → `finance.create_composed_invoice`. The door
 * recomputes every amount from the typed text; the totals on this screen are a
 * preview, never an input. The tax mode is not a control here: it is the
 * project's confirmed profile ("Update billing details only through a
 * controlled profile change"), so a project without one is blocked, with the
 * link to where it is confirmed.
 */
export function ComposerForm({ projects, supplierStateCode }: { projects: ComposerProject[]; supplierStateCode: string | null }) {
  const [state, action, pending] = useActionState(composeInvoiceAction, IDLE_STATE);
  const uid = useId();
  const [projectId, setProjectId] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([{ id: 1, description: '', quantity: '1', unitPrice: '' }]);
  const [nextId, setNextId] = useState(2);
  const [step, setStep] = useState<'compose' | 'review'>('compose');

  const project = projects.find((p) => p.projectId === projectId) ?? null;
  const taxRateBp = project?.mode === 'gst' ? GST_RATE_BP : 0;
  const composition = useMemo(
    () => composeLines(lines.map(({ description, quantity, unitPrice }) => ({ description, quantity, unitPrice })), taxRateBp),
    [lines, taxRateBp],
  );
  const currency = project?.currency ?? 'INR';
  const blocked = project !== null && (project.mode === null || !project.complete);
  const canReview = project !== null && !blocked && composition.ok;

  const setLine = (id: number, patch: Partial<ComposerLineInput>) => setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const breakdown =
    composition.ok && project
      ? taxBreakdown({
          mode: project.mode,
          subtotalMinor: composition.totals.subtotalMinor,
          taxMinor: composition.totals.taxMinor,
          supplierStateCode,
          placeOfSupplyCode: project.billingStateCode,
        })
      : null;

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="lines" value={JSON.stringify(lines.map(({ description, quantity, unitPrice }) => ({ description, quantity, unitPrice })))} />
      <input type="hidden" name="dueOn" value={dueOn} />
      <input type="hidden" name="notes" value={notes} />

      <ol className="flex flex-wrap items-center gap-2 text-[13px]" aria-label="Steps">
        <li className={`rounded-full px-3 py-1 font-medium ${step === 'compose' ? 'bg-brand text-white' : 'bg-surface-sunken text-muted'}`}>1. Compose</li>
        <li className={`rounded-full px-3 py-1 font-medium ${step === 'review' ? 'bg-brand text-white' : 'bg-surface-sunken text-muted'}`}>2. Review</li>
        <li className="rounded-full bg-surface-sunken px-3 py-1 text-muted">3. Issue (on the invoice)</li>
      </ol>

      {step === 'compose' ? (
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor={`${uid}-project`}>Project</label>
              <select id={`${uid}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)} className={selectClass}>
                <option value="">Choose a project…</option>
                {projects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.projectName}
                    {p.mode === null ? ' (billing mode not confirmed)' : p.complete ? '' : ' (billing details incomplete)'}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor={`${uid}-due`}>Due date (optional)</label>
              <input id={`${uid}-due`} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} className={inputClass} />
              <span className="text-xs text-muted">Left empty, the owner&apos;s default terms apply (Settings › Finance), else no due date.</span>
            </div>
          </div>

          {project ? (
            <div className="rounded-xl border border-line bg-surface p-4 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[13px] font-semibold tracking-tight">Tax mode and billing profile</h3>
                {project.mode ? <Badge tone={project.mode === 'gst' ? 'brand' : 'neutral'} mono>{project.mode === 'gst' ? 'GST' : 'Non-GST'}{project.version ? ` · v${project.version}` : ''}</Badge> : <Badge tone="warning">not confirmed</Badge>}
                <Link href={`/projects/${project.projectId}#billing`} className="ml-auto text-xs text-brand hover:underline">
                  {project.mode === null || !project.complete ? 'Confirm billing details' : 'Change billing details'}
                </Link>
              </div>
              {project.mode === null ? (
                <p className="mt-2 text-muted">A person has not confirmed whether this project is billed with GST. An invoice is never raised on a guess.</p>
              ) : (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="text-muted">Tax</dt>
                  <dd>{project.mode === 'gst' ? '18% GST on every line' : 'No GST on the Non-GST path'}</dd>
                  <dt className="text-muted">Legal name</dt>
                  <dd>{project.legalName ?? '—'}</dd>
                  <dt className="text-muted">State</dt>
                  <dd>{project.billingState ?? '—'}</dd>
                  {project.mode === 'gst' ? (
                    <>
                      <dt className="text-muted">GSTIN</dt>
                      <dd className="font-mono text-xs">{project.gstin ?? '—'}</dd>
                    </>
                  ) : null}
                </dl>
              )}
              {blocked && project.mode !== null ? (
                <p className="mt-2 text-warning">Billing details are incomplete — missing: {project.missing.join(', ') || 'details'}. Complete them before raising an invoice.</p>
              ) : null}
            </div>
          ) : null}

          <fieldset className="flex flex-col gap-3">
            <legend className="text-[13px] font-semibold tracking-tight">Line items</legend>
            <ul className="flex flex-col gap-3">
              {lines.map((l, index) => {
                const one = composeLines([{ description: l.description || 'x', quantity: l.quantity, unitPrice: l.unitPrice }], 0);
                return (
                  <li key={l.id} className="grid gap-2 rounded-lg border border-line bg-canvas p-3 sm:grid-cols-[minmax(0,1fr)_6rem_9rem_8rem_auto] sm:items-end">
                    <div className="flex flex-col gap-1">
                      <label className={labelClass} htmlFor={`${uid}-d${l.id}`}>Line {index + 1} description</label>
                      <input id={`${uid}-d${l.id}`} value={l.description} onChange={(e) => setLine(l.id, { description: e.target.value })} maxLength={300} className={inputClass} placeholder="What this line bills" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className={labelClass} htmlFor={`${uid}-q${l.id}`}>Qty</label>
                      <input id={`${uid}-q${l.id}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(l.id, { quantity: e.target.value })} className={inputClass} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className={labelClass} htmlFor={`${uid}-p${l.id}`}>Unit price ({currency})</label>
                      <input id={`${uid}-p${l.id}`} inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(l.id, { unitPrice: e.target.value })} className={inputClass} placeholder="0.00" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className={labelClass}>Amount</span>
                      <span className="tabular py-2 text-sm font-medium">{one.ok ? money(one.totals.subtotalMinor, currency) : '—'}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((x) => x.id !== l.id) : prev))}
                      disabled={lines.length === 1}
                      aria-label={`Remove line ${index + 1}`}
                      className={buttonClass('ghost', 'sm')}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
            <div>
              <button
                type="button"
                onClick={() => {
                  setLines((prev) => (prev.length >= 50 ? prev : [...prev, { id: nextId, description: '', quantity: '1', unitPrice: '' }]));
                  setNextId((n) => n + 1);
                }}
                className={buttonClass('secondary', 'sm')}
              >
                Add a line
              </button>
            </div>
          </fieldset>

          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor={`${uid}-notes`}>Notes (optional)</label>
            <textarea id={`${uid}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2000} className={inputClass} />
          </div>

          {!composition.ok && lines.some((l) => l.description.trim() || l.unitPrice.trim()) ? (
            <Callout tone="warning">{composition.errors[0]}</Callout>
          ) : null}

          {composition.ok && project ? (
            <div className="flex flex-col items-end gap-1 text-[13px]">
              <span className="text-muted">Subtotal <span className="tabular font-medium text-foreground">{money(composition.totals.subtotalMinor, currency)}</span></span>
              <span className="text-muted">{project.mode === 'gst' ? 'GST' : 'Tax'} <span className="tabular font-medium text-foreground">{money(composition.totals.taxMinor, currency)}</span></span>
              <span className="text-base font-semibold">Total <span className="tabular">{money(composition.totals.totalMinor, currency)}</span></span>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={!canReview} onClick={() => setStep('review')} className={buttonClass('primary', 'md')}>
              Review
            </button>
            <Link href="/invoices" className={buttonClass('ghost', 'md')}>Cancel</Link>
            {!project ? <span className="text-xs text-muted">Choose a project to continue.</span> : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {project && composition.ok && breakdown ? (
            <>
              <ComposerReview project={project} composition={composition} breakdown={breakdown} dueOn={dueOn} notes={notes} currency={currency} />
              <p className="text-xs text-muted">Generating creates a draft. Issuing it to the client is a separate step on the invoice, after one more look.</p>
            </>
          ) : null}
          <FormMessage status={state.status} message={state.message} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={pending || !canReview} className={buttonClass('primary', 'md')}>
              {pending ? 'Generating…' : 'Generate draft invoice'}
            </button>
            <button type="button" onClick={() => setStep('compose')} className={buttonClass('secondary', 'md')}>
              Back to edit
            </button>
          </div>
        </div>
      )}
      {step === 'compose' ? <FormMessage status={state.status} message={state.message} /> : null}
    </form>
  );
}
