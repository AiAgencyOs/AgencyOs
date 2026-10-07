import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readLimitsInForce, readNegotiationQueue } from '@/modules/sales/p1s-negotiation-queries';
import { Badge, Card, EmptyState, PageHeader, PermissionDenied, buttonClass, type Tone } from '@/ui';

import { LimitsPanel } from './limits-panel';

export const metadata: Metadata = { title: 'Negotiations' };

const money = (minor: number | null) => (minor === null ? 'n/a' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(minor / 100));
const STATUS_TONE: Record<string, Tone> = { accepted: 'success', sent: 'info', approved: 'info', pending_approval: 'warning', draft: 'neutral', rejected: 'danger', cancelled: 'danger', superseded: 'neutral', lapsed: 'warning' };

/**
 * Admin Panel A15, the Negotiation workspace (P1-BLUEPRINT-021). Every deal that is being negotiated, in one list: the objection that is open and what it
 * was, how many rounds it has had against the cap, the quotation version in play and its state, a discount or approval it is waiting on, a "yes" that did
 * not say which version, and the next action. The limits it is held to are above the list, each with where it comes from. A deal opens into its own
 * negotiation record (rounds, versions, acceptance with evidence). This page reads; it records nothing and approves nothing.
 */
export default async function NegotiationsPage() {
  const context = await requireInternal('/quotations/negotiation');
  if (!can(context, 'lead.read')) return <PermissionDenied />;
  const [queue, limits] = await Promise.all([readNegotiationQueue(), readLimitsInForce()]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Negotiations" description="Deals where the client has pushed back or a quotation is out. Deals that need a person come first." actions={<Link href="/quotations" className={buttonClass('secondary', 'sm')}>All quotations</Link>} />
      <LimitsPanel limits={limits} />
      {queue.length === 0 ? (
        <EmptyState title="Nothing is being negotiated" description="No open deal has an objection, a sent quotation or an unclear acceptance." />
      ) : (
        <ul className="flex flex-col gap-3">
          {queue.map((q) => (
            <li key={q.opportunityId}>
              <Card>
                <div className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/quotations/negotiation/${q.opportunityId}`} className="font-semibold underline-offset-2 hover:underline">{q.opportunityName}</Link>
                    <Badge>{q.stage}</Badge>
                    {q.proposalVersion !== null ? <Badge tone={STATUS_TONE[q.proposalStatus ?? ''] ?? 'neutral'} dot>Version {q.proposalVersion} · {(q.proposalStatus ?? '').replace('_', ' ')}</Badge> : <Badge tone="neutral">no quotation</Badge>}
                    {q.totalMinor !== null ? <span className="text-sm">{money(q.totalMinor)}{q.discountMinor ? ` after ${money(q.discountMinor)} off` : ''}</span> : null}
                    {q.atRoundCap ? <Badge tone="danger">at the round limit ({q.roundCap})</Badge> : null}
                    {q.acceptanceUnclear ? <Badge tone="warning">acceptance unclear</Badge> : null}
                    {q.pendingDiscountDecisions > 0 ? <Badge tone="warning">{q.pendingDiscountDecisions} discount awaiting approval</Badge> : null}
                  </div>
                  {q.latestConcern ? (
                    <p className="text-sm">
                      <span className="text-muted">Latest objection ({q.latestObjectionKind}, round {q.rounds}{q.openObjections > 0 ? ', open' : ', answered'}): </span>“{q.latestConcern}”
                    </p>
                  ) : null}
                  <p className="text-sm font-medium">Next: {q.nextAction}</p>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                    <span>{q.rounds} round{q.rounds === 1 ? '' : 's'}{q.roundCap !== null ? ` of ${q.roundCap}` : ''}</span>
                    {q.policyVersion ? <span>judged under {q.policyVersion}</span> : null}
                    {q.leadId ? <Link href={`/leads/${q.leadId}`} className="underline-offset-2 hover:underline">Open the lead</Link> : null}
                    <Link href={`/quotations/negotiation/${q.opportunityId}`} className="underline-offset-2 hover:underline">Open the negotiation record</Link>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
