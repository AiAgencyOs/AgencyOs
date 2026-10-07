import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';
import { listCloseExceptions, listFinanceAgentRunReports, listFinanceExceptions, listFinanceProposals, listWaivers, readClosePosition } from '@/modules/finance/phase-nine-queries';
import { AGENT_LABEL, PROPOSAL_KIND_LABEL, blockerTitle, closeModeLabel, formatMinor, resultLabel, resultTone } from '@/modules/finance/phase-nine-view';
import { Badge, buttonClass, Callout, Card, CardHeader, EmptyState, humanize, PageHeader, PermissionDenied } from '@/ui';

import { PhaseNineForm } from '../phase-nine-forms';

export const metadata: Metadata = { title: 'Financial close' };

const EXCEPTION_KINDS: [string, string][] = [
  ['wrong_amount', 'Wrong amount'], ['wrong_account', 'Wrong account'], ['unclear_proof', 'Unclear proof'], ['gateway_mismatch', 'Gateway mismatch'], ['overpayment', 'Overpayment'],
  ['unmatched_payment', 'Unmatched payment'], ['duplicate_payment', 'Duplicate payment'], ['refund_dispute', 'Refund dispute'], ['chargeback', 'Chargeback'], ['tax_correction', 'Tax correction'], ['other', 'Other'],
];

/**
 * One project's financial close (Phase 9): what was agreed, what was invoiced, what was actually VERIFIED as received, what was waived or refunded, what
 * is still owed and how old it is, the margin, and every blocker with its reason. The figures are the database's (finance.project_close_position); this
 * page computes nothing. Unverified money is shown on its own line and is never revenue. Closing is a Finance / Admin act the database checks under
 * lock, and it does not complete the project: Phase 7 still owns QA, handover and client acceptance.
 *
 * Nothing on this page verifies a payment, edits an invoice or an amount, records a refund or sends a client a message.
 */
export default async function FinanceClosePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const context = await requireInternal(`/finance/close/${projectId}`);
  if (!can(context, 'invoice.read')) return <PermissionDenied />;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) notFound();

  const position = await readClosePosition(projectId);
  if (!position) return <PermissionDenied description="This project is not visible to your role, or it does not exist." />;

  const supabase = await createClient();
  const [exceptions, waivers, closeExceptions, proposals, runReports, closeRow, invoices] = await Promise.all([
    listFinanceExceptions({ projectId }),
    listWaivers({ projectId }),
    listCloseExceptions(projectId),
    listFinanceProposals({ projectId }),
    listFinanceAgentRunReports(projectId),
    supabase.schema('finance').from('project_financial_closes' as never).select('mode, closed_at').eq('project_id', projectId).limit(1),
    supabase.schema('finance').from('invoices').select('id, number, status, total_minor').eq('project_id', projectId).in('status', ['issued', 'partially_paid', 'overdue']).order('created_at', { ascending: true }),
  ]);
  if (closeRow.error) unreadable('FinanceClosePage.close', closeRow.error);
  if (invoices.error) unreadable('FinanceClosePage.invoices', invoices.error);
  const closed = (closeRow.data as unknown as { mode: string; closed_at: string }[] | null)?.[0] ?? null;
  const t = position.totals;
  const money = (n: number | undefined) => formatMinor(n ?? 0, position.currency);
  const openExceptions = exceptions.filter((e) => e.state === 'open');
  const pendingWaivers = waivers.filter((w) => w.status === 'requested');
  const pendingCloseException = closeExceptions.find((c) => c.status === 'requested') ?? null;
  const invoiceOptions: [string, string][] = (invoices.data ?? []).map((i) => [String(i.id), `${String(i.number)} (${String(i.status)})`]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Financial close: ${position.projectName}`}
        description="What was agreed, invoiced, verified, waived, refunded and still owed. Verified money only."
        actions={<Link href="/finance/close" className={buttonClass('secondary', 'sm')}>All projects</Link>}
      />

      {closed ? (
        <Callout tone="success" title={closeModeLabel(closed.mode)}>
          Closed on {closed.closed_at.slice(0, 10)}. This is the financial close only: the project is not complete until Phase 7 says so. The close is a frozen record and is never edited.
        </Callout>
      ) : (
        <Callout tone={position.result === 'blocked' ? 'danger' : position.result === 'clear' ? 'success' : 'warning'} title={resultLabel(position.result)}>
          {position.result === 'clear' ? 'Every milestone is invoiced, no money is unverified, no blocking exception stands, and nothing is owed.' : 'See the blockers below. Each says why.'}
        </Callout>
      )}

      <Card className="flex flex-col gap-3 p-4">
        <CardHeader title="Position" description={position.marginBasis || undefined} actions={<Badge tone={resultTone(position.result)}>{resultLabel(position.result)}</Badge>} />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] md:grid-cols-4">
          {([
            ['Agreed (milestone plan)', t.contractMinor], ['Invoiced', t.invoicedMinor], ['Verified collected', t.collectedMinor], ['Refunded', t.refundedMinor],
            ['Net verified', t.verifiedNetMinor], ['Waived (not cash)', t.waivedMinor], ['Outstanding', t.outstandingMinor], ['Overdue', t.overdueMinor],
            ['Unverified (not revenue)', t.unverifiedMinor], ['Expenses', t.expensesMinor], ['AI cost', t.aiCostMinor], ['Time cost', t.timeCostMinor],
          ] as [string, number | undefined][]).map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted">{label}</dt>
              <dd className="font-medium text-foreground">{money(value)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[13px] text-foreground">
          Margin <span className="font-medium">{money(t.marginMinor)}</span>
          {position.marginPercent !== null ? ` (${position.marginPercent}% of verified revenue)` : ''}
          {t.uncostedHours ? <span className="text-muted">; {t.uncostedHours} h uncosted (no rate on those days)</span> : null}
        </p>
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <CardHeader title="By milestone" />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-muted">
              <tr><th className="py-1 pr-3">Milestone</th><th className="pr-3">Planned</th><th className="pr-3">Invoiced</th><th className="pr-3">Verified net</th><th className="pr-3">Waived</th><th className="pr-3">Outstanding</th><th>Unverified</th></tr>
            </thead>
            <tbody>
              {position.milestones.map((m, i) => (
                <tr key={m.milestoneId ?? `m-${i}`} className="border-t border-line">
                  <td className="py-1 pr-3 text-foreground">{m.name}{m.operationalStatus ? <span className="text-muted"> ({humanize(m.operationalStatus)})</span> : null}</td>
                  <td className="pr-3">{money(m.plannedMinor)}</td><td className="pr-3">{money(m.invoicedMinor)}</td><td className="pr-3">{money(m.verifiedNetMinor)}</td>
                  <td className="pr-3">{money(m.waivedMinor)}</td><td className="pr-3">{money(m.outstandingMinor)}</td><td>{money(m.unverifiedMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[13px] text-muted">
          Aging of what is owed: current {money(position.aging.current)}; 1-30 days {money(position.aging.days1to30)}; 31-60 {money(position.aging.days31to60)}; 61-90 {money(position.aging.days61to90)}; over 90 {money(position.aging.over90)}.
        </p>
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <CardHeader title="Blockers" description="Each has a reason. A balance can be excepted by an Admin; nothing else can." />
        {position.blockers.length === 0 ? (
          <p className="text-[13px] text-muted">Nothing blocks this close.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {position.blockers.map((b, i) => (
              <li key={`${b.code}-${b.ref ?? i}`} className="flex flex-wrap items-center gap-2">
                <Badge tone={b.waivable ? 'warning' : 'danger'}>{blockerTitle(b.code)}</Badge>
                <span className="text-foreground">{b.reason}</span>
                {b.amountMinor !== null ? <span className="text-muted">{money(b.amountMinor)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {closed ? null : (
        <Card className="flex flex-col gap-3 p-4">
          <CardHeader title="Close this project's finances" description="A Finance person or Admin closes. The database re-checks everything under lock." />
          <div className="grid gap-3 md:grid-cols-2">
            <PhaseNineForm door="evaluate" hidden={{ projectId }} submit="Record an evaluation" intro="Records where the close stands right now, so the history of attempts is kept." />
            <PhaseNineForm door="close_project" tone="primary" hidden={{ projectId }} fields={[{ kind: 'textarea', name: 'note', label: 'Note (optional)' }]} submit="Close the finances" intro="Refused while anything blocks it. A remaining balance closes only against an approved close exception." />
          </div>
          {position.result === 'outstanding_only' && !pendingCloseException ? (
            <PhaseNineForm door="request_close_exception" hidden={{ projectId }} fields={[{ kind: 'textarea', name: 'reason', label: 'Why the remaining balance may close', required: true }]} submit="Request a close exception" intro="An Admin who did not ask for it decides." />
          ) : null}
          {pendingCloseException ? (
            <div className="rounded-md border border-line p-3 text-[13px]">
              <p className="text-foreground">Close exception waiting: {money(pendingCloseException.outstandingMinor)}. {pendingCloseException.reason}</p>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <PhaseNineForm door="decide_close_exception" tone="primary" hidden={{ projectId, closeExceptionId: pendingCloseException.id, decision: 'approved' }} fields={[{ kind: 'text', name: 'note', label: 'Why approved', required: true }]} submit="Approve (Admin)" />
                <PhaseNineForm door="decide_close_exception" hidden={{ projectId, closeExceptionId: pendingCloseException.id, decision: 'rejected' }} fields={[{ kind: 'text', name: 'note', label: 'Why rejected', required: true }]} submit="Reject (Admin)" />
              </div>
            </div>
          ) : null}
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-4">
        <CardHeader title="Exceptions" description="Opened with a reason; a blocking one is resolved by someone who did not open it; a chargeback is settled by an Admin." />
        {exceptions.length === 0 ? <EmptyState title="No exceptions" description="Nothing has been opened on this project." /> : (
          <ul className="flex flex-col gap-2 text-[13px]">
            {exceptions.map((e) => (
              <li key={e.id} className="flex flex-col gap-1 rounded-md border border-line p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={e.state === 'open' ? (e.blocking ? 'danger' : 'warning') : 'neutral'}>{humanize(e.kind)}</Badge>
                  <Badge tone="neutral">{e.state}</Badge>
                  {e.invoiceNumber ? <span className="text-muted">{e.invoiceNumber}</span> : null}
                  {e.openedBySystem ? <span className="text-muted">opened by the runner</span> : null}
                </div>
                <span className="text-foreground">{e.reason}</span>
                {e.resolutionNote ? <span className="text-muted">Resolution: {e.resolutionNote}</span> : null}
                {e.state === 'open' ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    <PhaseNineForm door="resolve_exception" hidden={{ projectId, exceptionId: e.id, resolution: 'resolved' }} fields={[{ kind: 'text', name: 'note', label: 'How it was resolved', required: true }]} submit="Resolve" />
                    <PhaseNineForm door="resolve_exception" hidden={{ projectId, exceptionId: e.id, resolution: 'dismissed' }} fields={[{ kind: 'text', name: 'note', label: 'Why it is dismissed', required: true }]} submit="Dismiss" />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <PhaseNineForm door="open_exception" hidden={{ projectId }} fields={[
          { kind: 'select', name: 'kind', label: 'Kind', options: EXCEPTION_KINDS },
          ...(invoiceOptions.length ? [{ kind: 'select' as const, name: 'invoiceId', label: 'Invoice (optional)', options: [['', 'No particular invoice'], ...invoiceOptions] as [string, string][] }] : []),
          { kind: 'textarea', name: 'reason', label: 'What is wrong', required: true },
        ]} submit="Open an exception" />
        {openExceptions.length > 0 ? <p className="text-[13px] text-muted">{openExceptions.length} open.</p> : null}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <CardHeader title="Waivers" description="A waiver is not cash and not revenue. An Admin who did not ask decides it." />
        {waivers.length === 0 ? <p className="text-[13px] text-muted">No waiver on this project.</p> : (
          <ul className="flex flex-col gap-2 text-[13px]">
            {waivers.map((w) => (
              <li key={w.id} className="flex flex-col gap-1 rounded-md border border-line p-2">
                <span className="text-foreground">{w.invoiceNumber ?? 'Invoice'}: {money(w.amountMinor)} <Badge tone={w.status === 'approved' ? 'success' : w.status === 'rejected' ? 'neutral' : 'warning'}>{w.status}</Badge></span>
                <span className="text-muted">{w.reason}{w.decisionNote ? ` - Decision: ${w.decisionNote}` : ''}</span>
                {w.status === 'requested' ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    <PhaseNineForm door="decide_waiver" tone="primary" hidden={{ projectId, waiverId: w.id, decision: 'approved' }} fields={[{ kind: 'text', name: 'note', label: 'Why approved', required: true }]} submit="Approve (Admin)" />
                    <PhaseNineForm door="decide_waiver" hidden={{ projectId, waiverId: w.id, decision: 'rejected' }} fields={[{ kind: 'text', name: 'note', label: 'Why rejected', required: true }]} submit="Reject (Admin)" />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {invoiceOptions.length > 0 && pendingWaivers.length === 0 ? (
          <PhaseNineForm door="request_waiver" hidden={{ projectId }} fields={[
            { kind: 'select', name: 'invoiceId', label: 'Invoice', options: invoiceOptions },
            { kind: 'text', name: 'amount', label: 'Amount to waive (e.g. 5000.00)', required: true },
            { kind: 'textarea', name: 'reason', label: 'Why', required: true },
          ]} submit="Request a waiver" />
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <CardHeader title="Finance agent proposals" description="Stub-proven, installed disabled. They propose; a person who did not ask for the run accepts or rejects. Accepting sends nothing and moves no money." />
        <div className="grid gap-3 md:grid-cols-3">
          <PhaseNineForm door="request_agent_run" hidden={{ projectId, agentKey: 'finance_reconciliation' }} submit="Ask for reconciliation findings" />
          <PhaseNineForm door="request_agent_run" hidden={{ projectId, agentKey: 'finance_close' }} submit="Ask for a close-readiness note" />
          {invoiceOptions.length ? (
            <PhaseNineForm door="request_agent_run" hidden={{ projectId, agentKey: 'finance_communication' }} fields={[{ kind: 'select', name: 'invoiceId', label: 'Invoice to draft a reminder for', options: invoiceOptions }]} submit="Ask for a reminder draft" />
          ) : null}
        </div>
        {runReports.length ? (
          <ul className="flex flex-col gap-1 text-[13px]" aria-label="Agent run completion reports">
            {runReports.map((r) => (
              <li key={r.requestId} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2">
                <span className="text-muted">{AGENT_LABEL[r.agentKey] ?? r.agentKey}</span>
                <Badge tone={r.state === 'decided' ? 'success' : r.state === 'awaiting_decision' ? 'warning' : 'neutral'}>{humanize(r.state)}</Badge>
                <span className="text-muted">{r.proposalCount} proposal(s)</span>
                <span className="text-muted">{r.blockers.length ? r.blockers.join('; ') : r.handoff}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {proposals.length === 0 ? <p className="text-[13px] text-muted">No proposals yet.</p> : (
          <ul className="flex flex-col gap-2 text-[13px]">
            {proposals.map((p) => (
              <li key={p.id} className="flex flex-col gap-1 rounded-md border border-line p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">{PROPOSAL_KIND_LABEL[p.kind] ?? humanize(p.kind)}</Badge>
                  <span className="text-muted">{AGENT_LABEL[p.agentKey] ?? p.agentKey}</span>
                  {p.decision ? <Badge tone={p.decision === 'accepted' ? 'success' : 'neutral'}>{p.decision}</Badge> : <Badge tone="warning">awaiting a person</Badge>}
                </div>
                <span className="text-foreground">{p.summary}</span>
                {p.draftBody ? <blockquote className="border-l-2 border-line pl-2 text-muted">{p.draftBody}{p.amountMinor !== null ? ` (balance quoted: ${money(p.amountMinor)})` : ''}</blockquote> : null}
                {p.evidenceRefs.length ? <span className="text-muted">Evidence: {p.evidenceRefs.join(', ')}</span> : null}
                {p.decisionNote ? <span className="text-muted">Decision note: {p.decisionNote}</span> : null}
                {p.recordedOutcome && p.decision ? <span className="text-muted">Outcome: {humanize(p.recordedOutcome)}</span> : null}
                {!p.decision ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    <PhaseNineForm door="accept_proposal" tone="primary" hidden={{ projectId, proposalId: p.id }} fields={[{ kind: 'text', name: 'note', label: 'Note (optional)' }]} submit="Accept" />
                    <PhaseNineForm door="reject_proposal" hidden={{ projectId, proposalId: p.id }} fields={[{ kind: 'text', name: 'note', label: 'Why rejected', required: true }]} submit="Reject" />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
