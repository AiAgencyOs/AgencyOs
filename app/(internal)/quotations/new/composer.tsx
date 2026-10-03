'use client';

import Link from 'next/link';
import { useActionState, useMemo, useState } from 'react';

import { amountInWords } from '@/lib/money/amount-in-words';
import { IDLE_STATE } from '@/modules/identity/types';
import { composeQuotationAction, type ComposeQuotationState } from '@/modules/sales/actions';
import { Avatar, Badge, buttonClass, Callout, Card, CardHeader, cx, FormMessage, IconAlert, IconCheck, IconFile, IconPlus, IconSend, PageHeader, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

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
  /** SCR-012 — the deal's current owner (`opportunities.owner_id`). */
  ownerId: string | null;
  /** SCR-012 — the project's CONFIRMED billing mode, when the deal already has one; null means manual. */
  billingMode: 'gst' | 'non_gst' | null;
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
  defaultTerms,
  taxRatePercent,
  initialOpportunityId,
  charges,
  structures,
  roster,
}: {
  deals: ComposerDeal[];
  defaultValidUntil: string;
  validityDays: number;
  /** The standard commercial terms as they would print today — the owner's clause wording where they have set it (audit B-6). */
  defaultTerms: readonly string[];
  taxRatePercent: number | null;
  initialOpportunityId?: string;
  /** G-207 — the Admin-maintained third-party charges; the only figures a quotation may cite for them. */
  charges?: readonly { service: string; charge: string; source: string | null; checkedOn: string; stale: boolean }[];
  /** The agency's payment structures, for the schedule preview. */
  structures?: readonly { name: string; isDefault?: boolean; minAmountMinor: number | null; maxAmountMinor: number | null; milestones: { label: string; pct: number }[] }[];
  /** SCR-012 — who may own the deal; present only when the caller may assign (`lead.assign`). */
  roster?: readonly { userId: string; fullName: string; role: string }[];
}) {
  // Two submit buttons share this action: "Save as Draft" (intent=draft) keeps the
  // quotation a draft; "Send to Client" (intent=send) runs the whole governed walk
  // and submits it for the owner's approval, which is the only way it reaches the client.
  const [state, action, pending] = useActionState<ComposeQuotationState, FormData>(async (previous, formData) => {
    const intent = String(formData.get('intent') ?? '');
    if (intent === 'draft') formData.delete('submit');
    else if (intent === 'send') formData.set('submit', 'on');
    return composeQuotationAction(previous, formData);
  }, IDLE_STATE);
  const [opportunityId, setOpportunityId] = useState(initialOpportunityId ?? deals[0]?.opportunityId ?? '');
  const [lines, setLines] = useState<Line[]>([{ key: 1, description: '', quantity: '1', unitPrice: '' }]);
  const [discount, setDiscount] = useState('');
  const [tax, setTax] = useState('');
  const [structureName, setStructureName] = useState('');
  // SCR-012 — GST toggle. Starts on when the deal's project has a confirmed
  // GST billing mode, off when it is confirmed non-GST, and manual (off)
  // when the deal has no confirmed mode yet. Typing in the tax field turns
  // the toggle off: the number is then the person's, not the formula's.
  const [gst, setGst] = useState<boolean | null>(null);

  const deal = deals.find((d) => d.opportunityId === opportunityId) ?? null;
  const currency = deal?.currency ?? 'INR';
  const gstOn = gst ?? deal?.billingMode === 'gst';

  const subtotal = useMemo(() => lines.reduce((n, l) => n + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0), [lines]);
  const discountN = Number(discount) || 0;
  const taxN = Number(tax) || 0;

  // A charge's amount is text ("₹1,000/yr", "$5/month"); the digits are
  // pre-filled when there are any and the person confirms the price.
  const addChargeLine = (service: string, charge: string) => {
    const digits = charge.replace(/[^0-9.]/g, '');
    const price = digits && Number.isFinite(Number(digits)) ? String(Number(digits)) : '';
    setLines((ls) => [...ls, { key: Date.now(), description: `${service} — ${charge} (third-party, at cost)`, quantity: '1', unitPrice: price }]);
  };
  const structure = (structures ?? []).find((st) => st.name === structureName) ?? null;
  // The seeded 30/20/30/20 is the default (owner decision 2, round 2): a structure the owner set that fits wins, the default applies when nothing else does.
  const fitting = (structures ?? []).filter((st) => (st.minAmountMinor === null || total * 100 >= st.minAmountMinor) && (st.maxAmountMinor === null || total * 100 < st.maxAmountMinor));
  const suggestedStructure = fitting.find((st) => !st.isDefault) ?? fitting[0] ?? null;
  const suggestedTax = taxRatePercent !== null ? Math.round((Math.max(0, subtotal - discountN) * taxRatePercent) / 100) : null;
  const gstRate = taxRatePercent ?? 18;
  const gstTax = Math.round((Math.max(0, subtotal - discountN) * gstRate) / 100);
  const shownTax = gstOn ? String(gstTax) : tax;
  const shownTaxN = gstOn ? gstTax : taxN;
  const total = Math.max(0, subtotal - discountN + shownTaxN);

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  if (state.status === 'success' && state.leadId) {
    return (
      <Callout tone="success" icon={<IconCheck size={16} />} title={state.reference ? `Quotation ${state.reference} created` : 'Quotation created'}>
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
      <PageHeader
        title="Create Quotation"
        description="Create a professional quotation for your client"
        actions={
          <>
            <button type="submit" name="intent" value="draft" disabled={pending || !deal} className={buttonClass('secondary', 'sm')}>
              <IconFile size={14} />
              Save as Draft
            </button>
            <button type="submit" formAction="/api/quotations/preview" formMethod="post" formTarget="_blank" disabled={pending || !deal} className={buttonClass('secondary', 'sm')}>
              Preview
            </button>
            {/* Owner decision #13: Share (copy link) is offered only once the owner has approved the quotation — on the quotations list, not here. */}
            <button type="submit" name="intent" value="send" disabled={pending || !deal} title="Prices it and sends it to the owner for approval; it reaches the client once approved" className={buttonClass('primary', 'sm')}>
              <IconSend size={14} />
              {pending ? 'Working…' : 'Send to Client'}
            </button>
          </>
        }
      />

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
          <CardHeader title="Client Information" />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Deal</span>
              <select
                name="opportunityId"
                value={opportunityId}
                onChange={(e) => {
                  setOpportunityId(e.target.value);
                  setGst(null);
                }}
                required
                className={selectClass}
              >
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
          <CardHeader title="Quotation Details" />
          <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className={labelClass}>Title</span>
              <input name="title" required maxLength={200} className={inputClass} defaultValue={deal?.leadTitle ?? ''} placeholder="Mobile app — design and build" />
            </label>
            {/* SCR-012 — number and date. The number is DERIVED from the row
                (G-170: Q-<year>-<six hex of the id>), so it exists the moment
                the quotation does and not before; the composer says so
                rather than showing a number it cannot yet know. */}
            <div className="flex flex-col gap-1">
              <span className={labelClass}>Quotation number</span>
              <input value="Q-YYYY-…… — assigned on save" readOnly className={cx(inputClass, 'bg-surface-sunken text-muted')} aria-label="Quotation number" />
              <span className="text-[11px] text-muted">Derived from the record's id and date when it is created; printed on the PDF and shown in the list.</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className={labelClass}>Date</span>
              <input value={new Date().toISOString().slice(0, 10)} readOnly className={cx(inputClass, 'bg-surface-sunken text-muted')} aria-label="Quotation date" />
              <span className="text-[11px] text-muted">Today — the row's created date.</span>
            </div>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Valid until</span>
              <input name="validUntil" type="date" className={inputClass} defaultValue={defaultValidUntil} />
              <span className="text-[11px] text-muted">Default {validityDays} days, from Settings → Commercial.</span>
            </label>
            <input type="hidden" name="currency" value={currency} />
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Currency</span>
              <input value={currency} readOnly className={cx(inputClass, 'bg-surface-sunken')} />
              <span className="text-[11px] text-muted">The deal's currency.</span>
            </label>
            {/* SCR-012 — project type and duration. `sales.proposals` has no
                column for either, so the action writes them as the first
                lines of the scope note; the labels say so rather than
                implying a field the row does not have. */}
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Project type</span>
              <input name="projectType" maxLength={120} className={inputClass} placeholder="e.g. Web app + admin panel" />
              <span className="text-[11px] text-muted">Kept as the first line of the scope note — no column of its own.</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Duration</span>
              <input name="duration" maxLength={80} className={inputClass} placeholder="e.g. 8 weeks" />
              <span className="text-[11px] text-muted">Kept in the scope note, beside the project type.</span>
            </label>
            {roster && roster.length > 0 ? (
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className={labelClass}>Sales owner</span>
                <select name="ownerId" defaultValue={deal?.ownerId ?? ''} className={selectClass}>
                  <option value="">Leave as is{deal?.ownerId ? '' : ' (nobody yet)'}</option>
                  {roster.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.fullName} · {m.role.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-muted">Written to the deal (`opportunities.owner_id`) when the quotation is created.</span>
              </label>
            ) : null}
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className={labelClass}>Scope note (optional)</span>
              <textarea name="body" rows={3} maxLength={20000} className={textareaClass} placeholder="What this quotation covers, in the client's words." />
            </label>
          </div>
        </Card>

        <Card>
          <CardHeader title="Template & Settings" description="Amounts in the deal's currency." />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            {structures && structures.length > 0 ? (
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Quotation template</span>
                <select value={structureName || suggestedStructure?.name || ''} onChange={(e) => setStructureName(e.target.value)} className={selectClass}>
                  {structures.map((st) => (
                    <option key={st.name} value={st.name}>
                      {st.name}
                      {st === suggestedStructure ? ' (fits this total)' : ''}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-muted">One of the agency&apos;s payment structures; it sets the payment schedule below.</span>
              </label>
            ) : null}
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Discount</span>
              <input name="discount" type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} className={inputClass} placeholder="0" />
            </label>
            <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Tax{taxRatePercent !== null ? ` (GST ${taxRatePercent}%)` : ''}</span>
              <input
                name="tax"
                type="number"
                min="0"
                step="0.01"
                value={shownTax}
                onChange={(e) => {
                  setTax(e.target.value);
                  setGst(false);
                }}
                className={inputClass}
                placeholder="0"
              />
            </label>
              <label className="flex items-center gap-2 text-[12px] text-muted">
                <input
                  type="checkbox"
                  checked={gstOn}
                  onChange={(e) => {
                    setGst(e.target.checked);
                    if (e.target.checked) setTax(String(gstTax));
                  }}
                  className="h-4 w-4 rounded border-line-strong"
                />
                GST {gstRate}% on the discounted subtotal (untick for Non-GST)
                {deal?.billingMode === 'gst'
                  ? ' — pre-filled from the project’s confirmed GST billing mode'
                  : deal?.billingMode === 'non_gst'
                    ? ' — the project’s confirmed mode is non-GST; left off'
                    : ' — no confirmed billing mode on this deal yet; manual'}
              </label>
              {!gstOn && suggestedTax !== null && suggestedTax > 0 && Number(tax) !== suggestedTax ? (
                <button type="button" onClick={() => setTax(String(suggestedTax))} className="self-start text-[11px] font-medium text-brand hover:underline">
                  Apply {taxRatePercent}% → {money(suggestedTax, currency)}
                </button>
              ) : (
                <span className="text-[11px] text-muted">Every quotation says GST is extra; enter the tax this one carries.</span>
              )}
            </div>
          </div>
        </Card>

      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Card>
        <CardHeader
          title="Services / Items"
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
        {charges && charges.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:px-5">
            <span className={labelClass}>Third-party charges (at cost, as the Admin recorded them)</span>
            <div className="flex flex-wrap gap-1.5">
              {charges.map((c) => (
                <button key={c.service} type="button" onClick={() => addChargeLine(c.service, c.charge)} className={cx(buttonClass('secondary', 'sm'), c.stale ? 'border-warning/50' : '')} title={c.stale ? `Checked ${c.checkedOn} — over six months old` : `Checked ${c.checkedOn}`}>
                  <IconPlus size={12} /> {c.service} · {c.charge}
                  {c.stale ? <span className="text-[10px] text-warning">stale</span> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Card>
      <Card>
          <CardHeader title="Quotation Summary" />
          <dl className="flex flex-col gap-2 px-4 pb-4 text-[13px] sm:px-5">
            <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular">{money(subtotal, currency)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd className="tabular">− {money(discountN, currency)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd className="tabular">{money(shownTaxN, currency)}</dd></div>
            <div className="flex justify-between border-t border-line pt-2 text-base font-semibold"><dt>Total</dt><dd className="tabular">{money(total, currency)}</dd></div>
          </dl>
          {amountInWords(Math.round(total * 100), currency) ? (
            <div className="mx-4 mb-3 rounded-lg bg-surface-sunken px-3 py-2 sm:mx-5">
              <p className="text-[12px] font-medium text-muted">Amount in Words</p>
              <p className="text-[13px] font-medium text-foreground">{amountInWords(Math.round(total * 100), currency)}</p>
            </div>
          ) : null}
          <p className="px-4 pb-4 text-[11px] text-muted sm:px-5">Shown as you type. The stored total is computed by the pricing step from the saved lines.</p>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="flex min-w-0 flex-col gap-4">
        {structures && structures.length > 0 ? (
          <Card>
            <CardHeader title="Payment Schedule" description="How the total splits under the agency's payment terms. A preview only — the plan is set on the project once the deal is won." />
            <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
              {(() => {
                const chosen = structure ?? suggestedStructure ?? structures[0] ?? null;
                if (!chosen) return null;
                return (
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {chosen.milestones.map((m, i) => (
                      <li key={`${m.label}-${i}`} className="flex items-center justify-between gap-2 px-3 py-1.5 text-[13px]">
                        <span>{i + 1}. {m.label}</span>
                        <span className="text-muted">{m.pct}% · <span className="tabular text-foreground">{money(Math.round((total * m.pct) / 100), currency)}</span></span>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Approval" description="A quotation reaches the client only after the owner approves it." />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Note for the owner (optional)</span>
              <input name="summary" maxLength={500} className={inputClass} placeholder="Why this price" />
              <span className="text-[11px] text-muted">Sent with Send to Client. Save as Draft keeps the quotation a draft and sends nothing.</span>
            </label>
          </div>
        </Card>
        </div>
        <Card>
          <CardHeader title="Terms & Conditions" description="One clause per line. Printed on the PDF as the commercial terms; the standard clauses are pre-filled and every edit is what the owner approves." />
          <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
            <textarea name="commercialTerms" rows={6} maxLength={15000} defaultValue={defaultTerms.join('\n')} className={textareaClass} aria-label="Commercial terms, one per line" />
            <span className="text-[11px] text-muted">The validity clause is printed from the date above; leave it as it is unless this quotation's terms differ.</span>
          </div>
        </Card>

      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">Preview</p>
          <p className="text-xs text-muted">See how your quotation will look to the client</p>
        </div>
        <FormMessage status={state.status} message={state.status === 'error' && !state.leadId ? state.message : undefined} />
        <Link href="/quotations" className={buttonClass('ghost', 'md')}>
          Cancel
        </Link>
        {/* SCR-012 — the document as it would render, before anything is
            saved: the same form posts to the preview route in a new tab. */}
        <button type="submit" formAction="/api/quotations/preview" formMethod="post" formTarget="_blank" disabled={pending || !deal} className={buttonClass('secondary', 'md')}>
          Preview Quotation
        </button>
        <button type="submit" name="intent" value="draft" disabled={pending || !deal} className={buttonClass('secondary', 'md')}>
          Save as Draft
        </button>
        <button type="submit" name="intent" value="send" disabled={pending || !deal} className={buttonClass('primary', 'md')}>
          {pending ? 'Working…' : 'Send to Client'}
        </button>
      </div>
    </form>
  );
}
