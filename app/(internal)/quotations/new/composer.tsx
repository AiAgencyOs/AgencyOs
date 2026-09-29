'use client';

import Link from 'next/link';
import { useActionState, useMemo, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { composeQuotationAction, type ComposeQuotationState } from '@/modules/sales/actions';
import { Avatar, Badge, buttonClass, Callout, Card, CardHeader, cx, FormMessage, IconAlert, IconCheck, IconPlus, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

export type ComposerDeal = {
  opportunityId: string;
  leadId: string;
  name: string;
  leadTitle: string;
  contactName: string | null;
  contactPhone: string | null;
  company: string | null;
  stage: string;
  currency: string;
  valueMinor: number | null;
};

type Line = { key: number; description: string; quantity: string; unitPrice: string };

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
}

/**
 * The composer's form. The summary on the right is arithmetic over what is
 * typed, for the person's eyes while they type; the totals that count are
 * the ones the pricing door writes from the stored rows, and the lead page
 * shows those. The form posts once; the action walks the governed steps.
 */
export function QuotationComposer({
  deals,
  defaultValidUntil,
  validityDays,
  taxRatePercent,
  initialOpportunityId,
}: {
  deals: ComposerDeal[];
  defaultValidUntil: string;
  validityDays: number;
  taxRatePercent: number | null;
  initialOpportunityId?: string;
}) {
  const [state, action, pending] = useActionState<ComposeQuotationState, FormData>(composeQuotationAction, IDLE_STATE);
  const [opportunityId, setOpportunityId] = useState(initialOpportunityId ?? deals[0]?.opportunityId ?? '');
  const [lines, setLines] = useState<Line[]>([{ key: 1, description: '', quantity: '1', unitPrice: '' }]);
  const [discount, setDiscount] = useState('');
  const [tax, setTax] = useState('');
  const [submit, setSubmit] = useState(true);

  const deal = deals.find((d) => d.opportunityId === opportunityId) ?? null;
  const currency = deal?.currency ?? 'INR';

  const subtotal = useMemo(() => lines.reduce((n, l) => n + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0), [lines]);
  const discountN = Number(discount) || 0;
  const taxN = Number(tax) || 0;
  const total = Math.max(0, subtotal - discountN + taxN);
  const suggestedTax = taxRatePercent !== null ? Math.round((Math.max(0, subtotal - discountN) * taxRatePercent) / 100) : null;

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  if (state.status === 'success' && state.leadId) {
    return (
      <Callout tone="success" icon={<IconCheck size={16} />} title="Quotation created">
        {state.message}{' '}
        <Link href={`/leads/${state.leadId}#quotations`} className="font-medium underline underline-offset-2">
          Open it on the lead
        </Link>
        .
      </Callout>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      {deal ? <input type="hidden" name="leadId" value={deal.leadId} /> : null}

      {state.status === 'error' && state.leadId ? (
        <Callout tone="warning" icon={<IconAlert size={16} />}>
          {state.message}{' '}
          <Link href={`/leads/${state.leadId}#quotations`} className="font-medium underline underline-offset-2">
            Open the draft
          </Link>
          .
        </Callout>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(16rem,0.9fr)]">
        <Card>
          <CardHeader title="Client information" />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Deal</span>
              <select name="opportunityId" value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)} required className={selectClass}>
                {deals.length === 0 ? <option value="">No open deal to quote</option> : null}
                {deals.map((d) => (
                  <option key={d.opportunityId} value={d.opportunityId}>
                    {d.leadTitle} — {d.name}
                  </option>
                ))}
              </select>
            </label>
            {deal ? (
              <div className="flex items-start gap-3 rounded-lg border border-line bg-surface-sunken p-3">
                <Avatar name={deal.contactName ?? deal.leadTitle} size="md" />
                <dl className="min-w-0 flex-1 text-[13px]">
                  <dt className="sr-only">Contact</dt>
                  <dd className="flex items-center gap-2 font-medium text-foreground">
                    <span className="truncate">{deal.contactName ?? deal.leadTitle}</span>
                    <Badge tone="info">{deal.stage}</Badge>
                  </dd>
                  {deal.company ? <dd className="text-muted">{deal.company}</dd> : null}
                  {deal.contactPhone ? <dd className="font-mono text-xs text-muted">{deal.contactPhone}</dd> : null}
                  {deal.valueMinor !== null ? <dd className="text-xs text-muted">Deal value {money(deal.valueMinor / 100, deal.currency)}</dd> : null}
                </dl>
              </div>
            ) : (
              <p className="text-[13px] text-muted">
                A quotation belongs to an open deal on a lead. Open a deal from the lead first.{' '}
                <Link href="/leads" className="underline underline-offset-2">
                  Leads
                </Link>
              </p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Quotation details" />
          <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className={labelClass}>Title</span>
              <input name="title" required maxLength={200} className={inputClass} defaultValue={deal?.leadTitle ?? ''} placeholder="Mobile app — design and build" />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Valid until</span>
              <input name="validUntil" type="date" className={inputClass} defaultValue={defaultValidUntil} />
              <span className="text-[11px] text-muted">Default {validityDays} days, from Settings → Commercial.</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Currency</span>
              <input value={currency} readOnly className={cx(inputClass, 'bg-surface-sunken')} />
              <span className="text-[11px] text-muted">The deal's currency.</span>
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className={labelClass}>Scope note (optional)</span>
              <textarea name="body" rows={3} maxLength={20000} className={textareaClass} placeholder="What this quotation covers, in the client's words." />
            </label>
          </div>
        </Card>

        <Card>
          <CardHeader title="Quotation summary" />
          <dl className="flex flex-col gap-2 px-4 pb-4 text-[13px] sm:px-5">
            <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular">{money(subtotal, currency)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd className="tabular">− {money(discountN, currency)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd className="tabular">{money(taxN, currency)}</dd></div>
            <div className="flex justify-between border-t border-line pt-2 text-base font-semibold"><dt>Total</dt><dd className="tabular">{money(total, currency)}</dd></div>
          </dl>
          <p className="px-4 pb-4 text-[11px] text-muted sm:px-5">Shown as you type. The stored total is computed by the pricing step from the saved lines.</p>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Services / items"
          actions={
            <button type="button" onClick={() => setLines((ls) => [...ls, { key: Date.now(), description: '', quantity: '1', unitPrice: '' }])} className={buttonClass('primary', 'sm')}>
              <IconPlus size={14} />
              Add item
            </button>
          }
        />
        <div className="px-4 pb-4 sm:px-5">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                <th className="w-8 py-2">#</th>
                <th className="py-2">Description</th>
                <th className="w-24 py-2 text-right">Quantity</th>
                <th className="w-36 py-2 text-right">Unit price</th>
                <th className="w-32 py-2 text-right">Total</th>
                <th className="w-10 py-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key} className="border-b border-line last:border-0">
                  <td className="py-2 text-muted">{i + 1}</td>
                  <td className="py-2 pr-2">
                    <input name="lineDescription" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} maxLength={500} className={inputClass} placeholder="UI/UX design — complete app UI with Figma source" aria-label={`Line ${i + 1} description`} />
                  </td>
                  <td className="py-2 pr-2">
                    <input name="lineQuantity" type="number" min="0.01" step="0.01" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} className={cx(inputClass, 'text-right')} aria-label={`Line ${i + 1} quantity`} />
                  </td>
                  <td className="py-2 pr-2">
                    <input name="lineUnitPrice" type="number" min="0" step="0.01" value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} className={cx(inputClass, 'text-right')} placeholder="0" aria-label={`Line ${i + 1} unit price`} />
                  </td>
                  <td className="tabular py-2 text-right font-medium">{money((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), currency)}</td>
                  <td className="py-2 text-right">
                    <button type="button" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-40">
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Pricing" description="Amounts in the deal's currency." />
          <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Discount</span>
              <input name="discount" type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} className={inputClass} placeholder="0" />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Tax{taxRatePercent !== null ? ` (GST ${taxRatePercent}%)` : ''}</span>
              <input name="tax" type="number" min="0" step="0.01" value={tax} onChange={(e) => setTax(e.target.value)} className={inputClass} placeholder="0" />
              {suggestedTax !== null && suggestedTax > 0 && Number(tax) !== suggestedTax ? (
                <button type="button" onClick={() => setTax(String(suggestedTax))} className="self-start text-[11px] font-medium text-brand hover:underline">
                  Apply {taxRatePercent}% → {money(suggestedTax, currency)}
                </button>
              ) : (
                <span className="text-[11px] text-muted">Every quotation says GST is extra; enter the tax this one carries.</span>
              )}
            </label>
          </div>
        </Card>

        <Card>
          <CardHeader title="Approval" description="A quotation reaches the client only after the owner approves it." />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" name="submit" checked={submit} onChange={(e) => setSubmit(e.target.checked)} className="h-4 w-4 rounded border-line-strong" />
              Send to the owner for approval as soon as it is priced
            </label>
            {submit ? (
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Note for the owner (optional)</span>
                <input name="summary" maxLength={500} className={inputClass} placeholder="Why this price" />
              </label>
            ) : null}
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 rounded-xl border border-line bg-surface p-3 shadow-xs">
        <FormMessage status={state.status} message={state.status === 'error' && !state.leadId ? state.message : undefined} />
        <Link href="/quotations" className={buttonClass('ghost', 'md')}>
          Cancel
        </Link>
        <button type="submit" disabled={pending || !deal} className={buttonClass('primary', 'md')}>
          {pending ? 'Creating…' : submit ? 'Create and send for approval' : 'Save as draft'}
        </button>
      </div>
    </form>
  );
}
