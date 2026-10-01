import type { Composition } from '@/modules/finance/invoice-composer';
import type { TaxBreakdown } from '@/modules/finance/invoice-presentation';

export type ComposerProject = {
  projectId: string;
  projectName: string;
  currency: string;
  mode: 'gst' | 'non_gst' | null;
  version: number | null;
  legalName: string | null;
  gstin: string | null;
  billingState: string | null;
  billingStateCode: string | null;
  complete: boolean;
  missing: string[];
};

export function composerMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
}

type OkComposition = Extract<Composition, { ok: true }>;

/**
 * The composer's REVIEW step (PDF SCR-052): the lines as they will be stored,
 * the tax by the project's confirmed billing mode (CGST / SGST / IGST by place
 * of supply, with the reason stated), the total and the notes. Presentational
 * and pure — a server-renderable component with no state — so the step can be
 * rendered and asserted on its own (tests/composer-review-step.test.ts), apart
 * from the form's step switch. Nothing here writes anything.
 */
export function ComposerReview({
  project,
  composition,
  breakdown,
  dueOn,
  notes,
  currency,
}: {
  project: ComposerProject;
  composition: OkComposition;
  breakdown: TaxBreakdown;
  dueOn: string;
  notes: string;
  currency: string;
}) {
  const money = composerMoney;
  return (
    <div className="rounded-xl border border-line bg-surface p-4 text-[13px]">
      <h3 className="text-[13px] font-semibold tracking-tight">Review before generating</h3>
      <p className="mt-1 text-muted">
        {project.projectName} · {project.legalName ?? 'Client'} · {project.mode === 'gst' ? 'GST' : 'Non-GST'} · due {dueOn || 'per default terms'}
      </p>
      <table className="mt-3 w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-muted">
            <th className="py-1.5 pr-2 font-semibold">Description</th>
            <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
            <th className="px-2 py-1.5 text-right font-semibold">Unit</th>
            <th className="py-1.5 pl-2 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {composition.lines.map((l) => (
            <tr key={l.position} className="border-b border-line last:border-0">
              <td className="py-1.5 pr-2">{l.description}</td>
              <td className="tabular px-2 py-1.5 text-right text-muted">{l.quantity}</td>
              <td className="tabular px-2 py-1.5 text-right">{money(l.unitPriceMinor, currency)}</td>
              <td className="tabular py-1.5 pl-2 text-right font-medium">{money(l.amountMinor, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-3 ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        <dt className="text-muted">Subtotal</dt>
        <dd className="tabular text-right">{money(composition.totals.subtotalMinor, currency)}</dd>
        {breakdown.rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted">{r.label}</dt>
            <dd className="tabular text-right">{money(r.amountMinor, currency)}</dd>
          </div>
        ))}
        <dt className="font-semibold">Total</dt>
        <dd className="tabular text-right text-base font-semibold">{money(composition.totals.totalMinor, currency)}</dd>
      </dl>
      <p className="mt-2 text-xs text-muted">{breakdown.reason}</p>
      {notes ? <p className="mt-2 whitespace-pre-line text-muted">{notes}</p> : null}
    </div>
  );
}
