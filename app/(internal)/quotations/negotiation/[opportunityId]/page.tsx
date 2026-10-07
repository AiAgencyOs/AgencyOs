import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';
import { readNegotiationRounds, readQuoteReadiness, readQuoteTimeline, readVersionChangeSummary } from '@/modules/sales/p1o-quotation-service';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, buttonClass, type Tone } from '@/ui';

import { AcceptanceForm, CancelForm } from './quote-forms';

export const metadata: Metadata = { title: 'Negotiation' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (minor: number | null, currency = 'INR') => (minor === null ? 'n/a' : new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100));
const STATUS_TONE: Record<string, Tone> = { accepted: 'success', sent: 'info', approved: 'info', pending_approval: 'warning', draft: 'neutral', rejected: 'danger', cancelled: 'danger', superseded: 'neutral', lapsed: 'warning' };

type ProposalRow = {
  id: string; version: number; status: string; total_minor: number; currency: string; plan_label: string | null; policy_version: string | null;
  acceptance_channel: string | null; acceptance_evidence_ref: string | null; decided_at: string | null; sent_at: string | null; cancel_reason: string | null;
};

/**
 * Negotiation, one deal (P1-QUOTE-056/080/081/083, P1-HANDOFF-027/028). The rounds of objection and response joined to the version each was about, the discount
 * decisions and approval beside it, the typed client replies, what changed between versions, the policy each version was judged under, and the audit history
 * of any one quotation. Acceptance is recorded here with evidence; it is never inferred, and with several open versions the page asks which.
 */
export default async function NegotiationPage({ params }: { params: Promise<{ opportunityId: string }> }) {
  const { opportunityId } = await params;
  if (!UUID.test(opportunityId)) notFound();
  const context = await requireInternal(`/quotations/negotiation/${opportunityId}`);
  if (!can(context, 'lead.read')) return <PermissionDenied />;

  const supabase = await createClient();
  const { data: opp, error: oppError } = await supabase.schema('sales').from('opportunities').select('id, name, client_account_id').eq('id', opportunityId).maybeSingle();
  if (oppError) unreadable('negotiation.opportunity', oppError);
  if (!opp) notFound();

  const { data: proposals, error: proposalsError } = await supabase
    .schema('sales')
    .from('proposals' as never)
    .select('id, version, status, total_minor, currency, plan_label, policy_version, acceptance_channel, acceptance_evidence_ref, decided_at, sent_at, cancel_reason')
    .eq('opportunity_id', opportunityId)
    .order('version', { ascending: false });
  if (proposalsError) unreadable('negotiation.proposals', proposalsError);
  const versions = (proposals ?? []) as unknown as ProposalRow[];

  const contactQuery = opp.client_account_id
    ? await supabase.schema('crm').from('contacts').select('id, full_name').eq('client_account_id', opp.client_account_id).limit(50)
    : { data: [], error: null };
  if (contactQuery.error) unreadable('negotiation.contacts', contactQuery.error);
  const contacts = (contactQuery.data ?? []).map((c) => ({ id: c.id, name: c.full_name }));

  const [rounds, readiness] = await Promise.all([readNegotiationRounds(opportunityId), readQuoteReadiness(opportunityId)]);
  const summaries = await Promise.all(versions.slice(0, 6).map(async (v) => [v.id, await readVersionChangeSummary(v.id)] as const));
  const timelines = await Promise.all(versions.slice(0, 3).map(async (v) => [v.id, await readQuoteTimeline(v.id)] as const));
  const summaryOf = new Map(summaries);
  const timelineOf = new Map(timelines);
  const answerable = versions.filter((v) => v.status === 'sent' || v.status === 'lapsed');
  const canAct = can(context, 'proposal.send');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={`Negotiation: ${opp.name}`} description="Every round, the version it was about, and what the client said." actions={<Link href="/quotations" className={buttonClass('secondary', 'sm')}>All quotations</Link>} />

      <Card>
        <CardHeader title="Ready to quote?" description="What a quotation needs before it is drafted. A missing item is named, not guessed." />
        <CardBody>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {readiness.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2"><Badge tone={c.ok ? 'success' : 'warning'} dot>{c.ok ? 'ok' : 'missing'}</Badge><span>{c.name.replace(/_/g, ' ')}<span className="block text-xs text-muted">{c.detail}</span></span></li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Versions" description="Each version is a record that does not change; a revision is a new one." />
        <CardBody>
          {versions.length === 0 ? <EmptyState title="No quotation yet" /> : (
            <ul className="flex flex-col gap-4">
              {versions.map((v) => {
                const summary = summaryOf.get(v.id);
                const timeline = timelineOf.get(v.id);
                return (
                  <li key={v.id} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">Version {v.version}{v.plan_label ? ` · ${v.plan_label}` : ''}</span>
                      <Badge tone={STATUS_TONE[v.status] ?? 'neutral'} dot>{v.status.replace('_', ' ')}</Badge>
                      <span className="text-sm">{money(v.total_minor, v.currency)}</span>
                      {v.policy_version ? <Badge mono>{v.policy_version}</Badge> : null}
                    </div>
                    {v.status === 'accepted' ? <p className="mt-1 text-xs text-muted">Accepted via {v.acceptance_channel ?? 'unknown channel'}{v.acceptance_evidence_ref ? `, evidence: ${v.acceptance_evidence_ref}` : ', with no evidence on record (recorded before evidence was required)'}.</p> : null}
                    {v.status === 'cancelled' && v.cancel_reason ? <p className="mt-1 text-xs text-muted">Cancelled: {v.cancel_reason}</p> : null}
                    {summary && summary.previousVersion !== null ? (
                      <details className="mt-2 text-sm"><summary className="cursor-pointer">What changed since version {summary.previousVersion} ({summary.changes.length})</summary>
                        <ul className="mt-1 list-disc pl-5 text-xs">{summary.changes.map((c, i) => <li key={i}>{c.field === 'line' ? `line “${c.description}” ${c.change}` : `${c.field.replace('_', ' ')}: ${String(c.from ?? 'none')} → ${String(c.to ?? 'none')}`}</li>)}</ul>
                      </details>
                    ) : null}
                    {timeline && timeline.length > 0 ? (
                      <details className="mt-1 text-sm"><summary className="cursor-pointer">History ({timeline.length})</summary>
                        <ul className="mt-1 text-xs">{timeline.map((t, i) => <li key={i}>{new Date(t.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · {t.action} · {t.actorType}</li>)}</ul>
                      </details>
                    ) : null}
                    {canAct && ['draft', 'pending_approval', 'approved', 'sent'].includes(v.status) ? <div className="mt-2"><CancelForm proposalId={v.id} /></div> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Rounds" description="Objection, the response, and the version each led to." />
        <CardBody>
          {rounds.length === 0 ? <EmptyState title="No objections recorded" description="The client has not pushed back on this deal." /> : (
            <ol className="flex flex-col gap-3">
              {rounds.map((r) => (
                <li key={`${r.round}-${r.kind}`} className="rounded-lg border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">Round {r.round}</span><Badge dot>{r.kind}</Badge>{r.outcome ? <Badge tone="info">{r.outcome}</Badge> : null}{r.proposalVersion !== null ? <span className="text-xs text-muted">about version {r.proposalVersion} ({r.proposalStatus}) · {money(r.totalMinor)}{r.discountMinor ? ` after ${money(r.discountMinor)} off` : ''}</span> : null}</div>
                  <p className="mt-1">“{r.concern}”</p>
                  {r.response ? <p className="mt-1 text-muted">We said: {r.response}</p> : null}
                  {r.nextAction ? <p className="mt-1 text-xs text-muted">Next: {r.nextAction}</p> : null}
                  {r.discountDecisions.length > 0 ? <p className="mt-1 text-xs">Discount: {r.discountDecisions.map((d) => `${money(d.discountMinor)} (${d.pct}%) ${d.status}`).join('; ')}{r.approvalState ? ` · approval ${r.approvalState}` : ''}</p> : null}
                  {r.clientResponses.length > 0 ? <p className="mt-1 text-xs">Client replies: {r.clientResponses.map((c) => c.class.replace(/_/g, ' ')).join(', ')}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      {canAct && answerable.length > 0 && contacts.length > 0 ? (
        <Card>
          <CardHeader title="Record the client's acceptance" description="One exact version, who said it, where, and the evidence. If several versions are open and the client did not say which, nothing is accepted and you are told to ask." />
          <CardBody><AcceptanceForm proposals={answerable.map((v) => ({ id: v.id, version: v.version, label: `Version ${v.version}${v.plan_label ? ` · ${v.plan_label}` : ''} · ${money(v.total_minor, v.currency)}` }))} contacts={contacts} /></CardBody>
        </Card>
      ) : null}
    </div>
  );
}
