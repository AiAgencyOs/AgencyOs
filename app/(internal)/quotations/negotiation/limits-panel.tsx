import Link from 'next/link';

import type { LimitInForce, LimitsInForce } from '@/modules/sales/p1s-negotiation-queries';
import { Badge, Card, CardBody, CardHeader } from '@/ui';

function where(l: LimitInForce): React.ReactNode {
  if (l.source === 'policy_version') return <Badge tone="info">policy version {l.policyVersion ?? ''}</Badge>;
  if (l.source === 'setting') return <Badge>organization setting</Badge>;
  return <Badge tone="warning">not set</Badge>;
}

const rupees = (v: number | null) => (v === null ? 'no limit' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v));

/**
 * The limits a negotiation is held to, each with where it comes from: an active policy version when one carries the field (that is the authority), else the
 * organization setting; "not set" means no bound at all, and the page says so. Read from `sales.p1s_limits_in_force`, the same function family the discount
 * and offer doors consult, so what is shown is what is enforced.
 */
export function LimitsPanel({ limits }: { limits: LimitsInForce | null }) {
  if (!limits) {
    return (
      <Card>
        <CardHeader title="Limits" description="The limits could not be read for this account." />
      </Card>
    );
  }
  const rows: Array<{ label: string; value: string; source: LimitInForce | null; note?: string }> = [
    { label: 'Largest discount', value: limits.maxDiscountPct.value === null ? 'no limit' : `${limits.maxDiscountPct.value}%`, source: limits.maxDiscountPct, note: 'above this a discount needs an approval' },
    { label: 'Lowest price we will sell at', value: rupees(limits.minPriceRupees.value), source: limits.minPriceRupees },
    { label: 'Largest quotation an agent may send', value: rupees(limits.maxAutonomousQuoteRupees.value), source: limits.maxAutonomousQuoteRupees, note: 'above this a person decides' },
    { label: 'Rounds before it must be escalated', value: limits.maxRounds === null ? 'no limit' : String(limits.maxRounds), source: null },
    { label: 'Largest discount amount', value: limits.maxDiscountMinor === null ? 'no limit' : rupees(limits.maxDiscountMinor / 100), source: null },
    { label: 'Smallest advance', value: limits.minAdvancePct === null ? 'no limit' : `${limits.minAdvancePct}%`, source: null },
  ];
  return (
    <Card>
      <CardHeader title="Limits in force" description="What a negotiation may and may not do without a person. A limit that is not set is no limit at all." actions={<Link href="/settings/policy-versions" className="text-xs underline-offset-2 hover:underline">Policy versions</Link>} />
      <CardBody>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-1">
              <dt className="text-muted">{r.label}</dt>
              <dd className="flex items-center gap-2 font-medium">
                {r.value}
                {r.source ? where(r.source) : null}
              </dd>
              {r.note ? <p className="w-full text-xs text-muted">{r.note}</p> : null}
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}
