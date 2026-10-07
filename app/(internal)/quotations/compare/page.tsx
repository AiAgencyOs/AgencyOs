import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { compareProposals, type FieldChange, type ItemChange } from '@/modules/sales/proposal-diff';
import { getProposal } from '@/modules/sales/queries';
import { Badge, buttonClass, Card, EmptyState, PageHeader, PermissionDenied } from '@/ui';

export const metadata: Metadata = { title: 'Compare quotation versions' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
}

function shown(change: FieldChange, side: 'from' | 'to', currency: string): string {
  const v = side === 'from' ? change.from : change.to;
  if (v === null || v === '') return 'none';
  if (change.kind === 'money' && typeof v === 'number') return money(v, currency);
  if (change.field === 'body') return 'changed (see the quotation)';
  return String(v);
}

const WHAT: Record<'quantity' | 'unit_price' | 'amount', string> = { quantity: 'quantity', unit_price: 'unit price', amount: 'amount' };

/**
 * P1-BLUEPRINT-018 — compare two versions of one quotation, side by side in words. Read-only: it changes nothing, sends nothing and decides nothing about
 * which version is live. Both versions are read through `getProposal` (row-level security applies), the two must belong to the SAME deal, and a version the
 * caller cannot read is reported as unavailable rather than guessed at.
 */
export default async function CompareQuotationVersionsPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const context = await requireInternal('/quotations/compare');
  if (!can(context, 'lead.read')) return <PermissionDenied />;

  const { a, b } = await searchParams;
  if (!a || !b || !UUID.test(a) || !UUID.test(b)) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Compare quotation versions" description="Pick two versions of one deal from the version history on the quotations list." />
        <EmptyState title="Nothing to compare yet" description="Open a deal's version history and choose Compare." />
      </div>
    );
  }

  const [first, second] = await Promise.all([getProposal(a), getProposal(b)]);
  if (!first || !second) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Compare quotation versions" />
        <EmptyState title="A version is not available" description="One of the two versions does not exist or is not visible to you." />
      </div>
    );
  }
  if (first.opportunity_id !== second.opportunity_id) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Compare quotation versions" />
        <EmptyState title="Different deals" description="Only versions of the same deal can be compared." />
      </div>
    );
  }

  // older on the left, whatever order the link named them in
  const [older, newer] = first.version <= second.version ? [first, second] : [second, first];
  const result = compareProposals(older, newer);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`${newer.title}: version ${older.version} to version ${newer.version}`}
        description="What changed between the two versions. Money is shown exactly as stored; nothing here edits a quotation."
        actions={
          <Link href="/quotations" className={buttonClass('secondary', 'sm')}>
            Back to quotations
          </Link>
        }
      />

      {result.currencyChanged ? (
        <Card className="p-4">
          <Badge tone="warning">Currency changed</Badge> <span className="text-sm">The two versions are priced in different currencies, so the amounts below are not directly comparable.</span>
        </Card>
      ) : null}

      {result.identical ? (
        <EmptyState title="No differences" description="These two versions say the same thing." />
      ) : (
        <>
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">Terms and totals</h2>
            {result.fields.length === 0 ? (
              <p className="text-sm text-ink-muted">No change to the terms or totals.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-ink-muted">
                    <th className="py-1 pr-4 font-medium">Field</th>
                    <th className="py-1 pr-4 font-medium">Version {older.version}</th>
                    <th className="py-1 font-medium">Version {newer.version}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.fields.map((f) => (
                    <tr key={f.field} className="border-t border-line">
                      <td className="py-1.5 pr-4">{f.label}</td>
                      <td className="py-1.5 pr-4">{shown(f, 'from', older.currency)}</td>
                      <td className="py-1.5">{shown(f, 'to', newer.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">Lines</h2>
            {result.items.length === 0 ? (
              <p className="text-sm text-ink-muted">No change to the lines.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {result.items.map((c: ItemChange, i) => (
                  <li key={`${c.type}-${c.description}-${i}`} className="flex flex-wrap items-center gap-2">
                    <Badge tone={c.type === 'added' ? 'success' : c.type === 'removed' ? 'danger' : 'info'}>{c.type}</Badge>
                    <span className="font-medium">{c.description}</span>
                    {c.type === 'added' ? <span className="text-ink-muted">{money(c.to.amount_minor, newer.currency)}</span> : null}
                    {c.type === 'removed' ? <span className="text-ink-muted">was {money(c.from.amount_minor, older.currency)}</span> : null}
                    {c.type === 'changed' ? (
                      <span className="text-ink-muted">
                        {c.what.map((w) => WHAT[w]).join(', ')}: {money(c.from.amount_minor, older.currency)} to {money(c.to.amount_minor, newer.currency)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
