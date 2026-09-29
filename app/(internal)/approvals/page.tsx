import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { LiveRefresh } from '@/lib/realtime';
import { buttonClass, Badge, Card, CardHeader, EmptyState, FilterBar, FilterChips, IconApprovals, IconCheck, IconClock, IconAlert, PageHeader, Stat, StatGrid, statusTone, humanize } from '@/ui';
import { listApprovalPolicies, listDecidedApprovals, listPendingApprovals } from '@/modules/approvals/queries';
import { APPROVER_ROLES, isOverdue, type ApprovalState } from '@/modules/approvals/schema';
import type { ApprovalPolicyRow } from '@/modules/approvals/types';

import { DecideInDrawer } from './decide-drawer';

export const metadata: Metadata = { title: 'Approvals' };

const MONEY = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** What a subject type is called on screen. Vocabulary, not logic. */
const SUBJECT_LABEL: Record<string, string> = {
  proposal: 'Proposal',
  deliverable: 'Deliverable',
  invoice: 'Invoice',
  refund: 'Refund',
  scope_change: 'Scope change',
  prototype: 'Prototype',
  agent_action: 'Agent action',
  ticket_plan: 'Ticket plan',
};

/**
 * The approval centre — gap G-044, directive §27.
 *
 * Everything waiting on a human, in one place, soonest deadline first. Before
 * this page the engine held decisions nobody could see, which is most of the
 * distance between a schema and a working gate.
 *
 * **No capability check guards this route, and that is deliberate.** Every
 * other internal page re-checks a capability because its rows are readable by
 * roles that should not see that screen. Here the queue *is* the capability:
 * `approval_requests_select` admits internal roles of the caller's own
 * organization and nothing else, so a contractor typing the URL gets their own
 * organization's queue and can settle none of it — `decide_approval` checks the
 * required role under a lock. There is no narrower capability to check that
 * would not be a worse copy of the rule the row already carries.
 *
 * The reads refuse rather than render empty (G-054): "nothing needs your
 * attention" is the single most expensive lie this application could tell.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; role?: string }>;
}) {
  await requireInternal('/approvals');
  const clock = await agencyClock();
  const { type: typeFilter, role: roleFilter } = await searchParams;

  const [allPending, policies, decided] = await Promise.all([listPendingApprovals(), listApprovalPolicies(), listDecidedApprovals(50)]);
  // SCR-068: filters by subject type and required role, as chips that
  // round-trip through the URL. The KPIs stay over the whole queue — a
  // filtered "waiting" count would read as the queue being shorter than it is.
  const pending = allPending.filter((r) => (!typeFilter || r.subject_type === typeFilter) && (!roleFilter || r.required_role === roleFilter));
  const typesPresent = [...new Set(allPending.map((r) => r.subject_type))].sort();
  const filterHref = (over: { type?: string; role?: string }) => {
    const p = new URLSearchParams();
    const merged = { type: typeFilter, role: roleFilter, ...over };
    if (merged.type) p.set('type', merged.type);
    if (merged.role) p.set('role', merged.role);
    const s = p.toString();
    return s ? `/approvals?${s}` : '/approvals';
  };
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const decidedThisWeek = decided.filter((r) => (r.decided_at ?? r.created_at) >= weekAgo);
  const approvedCount = decided.filter((r) => r.state === 'approved').length;
  const rejectedCount = decided.filter((r) => r.state === 'rejected').length;
  const approvalRate = approvedCount + rejectedCount > 0 ? Math.round((approvedCount / (approvedCount + rejectedCount)) * 100) : null;
  const decisionHours = decided
    .filter((r) => r.decided_at)
    .map((r) => (new Date(r.decided_at as string).getTime() - new Date(r.created_at).getTime()) / 36e5)
    .filter((h) => h >= 0);
  const medianHours = decisionHours.length > 0 ? [...decisionHours].sort((a, b) => a - b)[Math.floor(decisionHours.length / 2)] ?? null : null;
  const late = allPending.filter((request) =>
    isOverdue({ state: request.state as ApprovalState, slaDueAt: request.sla_due_at }),
  ).length;

  // Group the active policies by subject type so each subject reads as a ladder
  // — the shape the resolver walks (highest threshold at or below the amount).
  // listApprovalPolicies already orders by subject then ascending amount.
  const policyGroups = new Map<string, ApprovalPolicyRow[]>();
  for (const policy of policies) {
    const group = policyGroups.get(policy.subject_type) ?? [];
    group.push(policy);
    policyGroups.set(policy.subject_type, group);
  }
  // Where a request would escalate — read-only. ADM-08c: an unanswered
  // request expires on the cron tick and is raised again with the owner; if
  // the subject's own ladder has a higher rung, that rung is the policy the
  // re-raise would route by. Nothing here escalates anything.
  const escalationFor = (subjectType: string, amountMinor: number | null, requiredRole: string): ApprovalPolicyRow | null => {
    const ladder = policyGroups.get(subjectType) ?? [];
    return ladder.find((p) => p.min_amount_minor > (amountMinor ?? 0) && p.required_role !== requiredRole) ?? null;
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Approvals"
        description={
          pending.length === 0
            ? 'Nothing is waiting on a decision.'
            : `${pending.length} waiting${late > 0 ? ` · ${late} past its deadline` : ''}.`
        }
        actions={<LiveRefresh topics={['approvals']} />}
        meta={
          pending.length > 0 ? (
            <>
              <Badge tone="info" dot>
                {pending.length} pending
              </Badge>
              {late > 0 ? (
                <Badge tone="danger" dot>
                  {late} overdue
                </Badge>
              ) : null}
            </>
          ) : null
        }
      />

      <StatGrid cols={5}>
        <Stat label="Waiting" value={String(pending.length)} caption={pending.length === 0 ? 'Queue is clear' : 'Need a decision'} tone={pending.length > 0 ? 'info' : 'neutral'} icon={<IconClock size={16} />} />
        <Stat label="Past deadline" value={String(late)} caption={late > 0 ? 'SLA breached' : 'All within SLA'} tone={late > 0 ? 'danger' : 'success'} icon={<IconAlert size={16} />} />
        <Stat label="Decided this week" value={String(decidedThisWeek.length)} caption={`${decided.length} in the recent history`} tone="brand" icon={<IconCheck size={16} />} />
        <Stat label="Approval rate" value={approvalRate === null ? '—' : `${approvalRate}%`} caption={approvalRate === null ? 'Nothing decided yet' : `${approvedCount} approved · ${rejectedCount} rejected`} tone={approvalRate !== null && approvalRate >= 50 ? 'success' : 'neutral'} icon={<IconCheck size={16} />} />
        <Stat label="Median time to decide" value={medianHours === null ? '—' : medianHours < 1 ? `${Math.round(medianHours * 60)}m` : medianHours < 48 ? `${Math.round(medianHours)}h` : `${Math.round(medianHours / 24)}d`} caption="From request to decision" tone="accent" icon={<IconClock size={16} />} />
      </StatGrid>

      {allPending.length > 0 ? (
        <FilterBar clearHref="/approvals" filtered={Boolean(typeFilter || roleFilter)}>
          <FilterChips
            options={[
              { key: 'all-types', label: 'Every type', href: filterHref({ type: undefined }), active: !typeFilter },
              ...typesPresent.map((t) => ({ key: `t-${t}`, label: SUBJECT_LABEL[t] ?? t, href: filterHref({ type: t }), active: typeFilter === t })),
            ]}
          />
          <FilterChips
            options={[
              { key: 'all-roles', label: 'Any role', href: filterHref({ role: undefined }), active: !roleFilter },
              ...APPROVER_ROLES.map((r) => ({ key: `r-${r}`, label: `needs ${r.replace('_', ' ')}`, href: filterHref({ role: r }), active: roleFilter === r })),
            ]}
          />
        </FilterBar>
      ) : null}

      {pending.length === 0 ? (
        <EmptyState
          icon={<IconApprovals size={22} />}
          title={allPending.length > 0 ? 'Nothing matches these filters' : 'Nothing is waiting on a decision'}
          description={
            allPending.length > 0
              ? `${allPending.length} request${allPending.length === 1 ? '' : 's'} waiting under other filters.`
              : 'When something needs a decision — a deliverable, an invoice, a refund — it appears here.'
          }
          action={allPending.length > 0 ? <Link href="/approvals" className={buttonClass('secondary', 'sm')}>Clear filters</Link> : <Link href="/dashboard" className={buttonClass('secondary', 'sm')}>Back to the Command Center</Link>}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {pending.map((request) => {
            const overdue = isOverdue({
              state: request.state as ApprovalState,
              slaDueAt: request.sla_due_at,
            });

            return (
              <li key={request.id}>
                <Card className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/approvals/${request.id}`}
                        className="text-sm font-medium underline-offset-2 hover:underline"
                      >
                        {SUBJECT_LABEL[request.subject_type] ?? request.subject_type}
                      </Link>

                      {request.audience === 'client' ? <Badge tone="info">client</Badge> : null}

                      {request.amount_minor !== null ? (
                        <span className="text-xs text-muted">
                          {MONEY.format(request.amount_minor / 100)}
                        </span>
                      ) : null}
                    </div>

                    <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
                      {request.summary ?? 'No summary was given when this was raised.'}
                    </p>

                    {/*
                      G-202 — the thing being approved, on the page where it is
                      approved.

                      ADM-96 says the PDF is what the owner decides against, and
                      it reached them everywhere except here: the WhatsApp
                      announcement carries it, the lead's quotation panel links
                      it, and this queue — the one screen whose entire purpose
                      is deciding — showed a summary somebody else wrote and an
                      amount.

                      The same route the lead page uses, gated the same way
                      (`lead.read`). Every version, not just the live one: the
                      PDF's own status band says what it is.
                    */}
                    {request.subject_type === 'proposal' && request.subject_id ? (
                      <a
                        href={`/api/quotations/${request.subject_id}/pdf`}
                        target="_blank"
                        rel="noreferrer"
                        className="w-fit text-xs text-muted underline underline-offset-2 hover:text-foreground"
                      >
                        Read the quotation before deciding
                      </a>
                    ) : null}

                    <p className="text-xs text-muted">
                      Needs {request.required_role.replace('_', ' ')} · raised by{' '}
                      {request.requested_by_type === 'system'
                        ? 'the system'
                        : request.requested_by_type}{' '}
                      · {clock.dateTime(request.created_at)}
                    </p>
                    {(() => {
                      const rung = escalationFor(request.subject_type, request.amount_minor, request.required_role);
                      return (
                        <p className="text-xs text-muted">
                          If unanswered by its deadline it expires and is raised again with the owner
                          {rung ? (
                            <>
                              {' '}
                              — the rung above is{' '}
                              <a href={`#policy-${rung.id}`} className="underline underline-offset-2">
                                ≥ {MONEY.format(rung.min_amount_minor / 100)} → {rung.required_role.replace(/_/g, ' ')}
                              </a>
                            </>
                          ) : (
                            ' (no higher rung on this ladder)'
                          )}
                          .
                        </p>
                      );
                    })()}
                  </div>

                  <Badge tone={overdue ? 'danger' : 'neutral'} dot={overdue}>
                    {overdue ? 'Overdue since ' : 'Due '}
                    {clock.dateTime(request.sla_due_at)}
                  </Badge>
                </div>

                {/* Bucket F: the decision opens in the drawer — the same
                    ApprovalDecisionForm, with the request's facts in view. */}
                <div className="mt-3 flex items-center justify-end border-t border-line pt-3">
                  <DecideInDrawer
                    requestId={request.id}
                    audience={request.audience}
                    subjectType={request.subject_type}
                    subjectLabel={SUBJECT_LABEL[request.subject_type] ?? request.subject_type}
                    summary={request.summary}
                    amountLabel={request.amount_minor !== null ? MONEY.format(request.amount_minor / 100) : null}
                    requiredRole={request.required_role}
                    dueLabel={clock.dateTime(request.sla_due_at)}
                    overdue={overdue}
                    quotationHref={request.subject_type === 'proposal' && request.subject_id ? `/api/quotations/${request.subject_id}/pdf` : null}
                  />
                </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {/*
        ADM-08c: an unanswered request expires and escalates to the owner. The
        cron tick does that now (G-096), so this text says what happens rather
        than apologising for what does not.
      */}
      {late > 0 ? (
        <p className="text-xs text-muted">
          Anything past its deadline is expired on the next cron tick and raised again with the owner.
          Nothing is ever approved by silence.
        </p>
      ) : null}

      {/*
        The rules that decide what lands in the queue above and who must answer
        it — read-only. Every request here was routed by one of these: the
        resolver takes the highest threshold at or below the amount, so a
        subject's policies read as a ladder (any amount → ops_admin, ≥ ₹5L →
        owner). This SHOWS them so an operator can see why a request needs the
        role it does; it does NOT edit them. Changing who may approve what is an
        authority change, owner-only and audited, made deliberately in the
        database — not a screen a queue view should hand out. `unreadable()` in
        the query means a failed read refuses rather than implying no rules.
      */}
      {policies.length > 0 ? (
        <section className="flex flex-col gap-3 border-t border-line pt-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-[13px] font-semibold tracking-tight">Policies in force</h2>
            <p className="text-xs text-muted">
              What needs a decision, and from whom. Read-only here — the owner changes a policy under
              Settings › Approvals, and every change is an audited authority change.
            </p>
          </div>

          <ul className="flex flex-col gap-3">
            {[...policyGroups.entries()].map(([subjectType, group]) => (
              <li
                key={subjectType}
                className="rounded-lg border border-line bg-surface px-4 py-3"
              >
                <div className="mb-2 text-sm font-medium">
                  {SUBJECT_LABEL[subjectType] ?? subjectType}
                </div>
                {/* The ladder as a stepper: thresholds ascending left to right, the role each rung requires beneath it. */}
                <ol className="mb-3 flex flex-wrap items-start gap-0 text-xs">
                  {group.map((policy, index) => (
                    <li key={`step-${policy.id}`} id={`policy-${policy.id}`} className="flex items-start">
                      <span className="flex flex-col items-center gap-1">
                        <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold text-brand-fg tabular">
                          {index + 1}
                        </span>
                        <span className="whitespace-nowrap font-medium tabular">
                          {policy.min_amount_minor > 0 ? `≥ ${MONEY.format(policy.min_amount_minor / 100)}` : 'Any amount'}
                        </span>
                        <span className="whitespace-nowrap text-muted">{policy.required_role.replace(/_/g, ' ')}</span>
                      </span>
                      {index < group.length - 1 ? <span className="mx-2 mt-3 h-px w-8 bg-line-strong" aria-hidden /> : null}
                    </li>
                  ))}
                </ol>
                <ul className="flex flex-col gap-1.5">
                  {group.map((policy) => (
                    <li
                      key={policy.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm"
                    >
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="tabular">
                          {policy.min_amount_minor > 0
                            ? `≥ ${MONEY.format(policy.min_amount_minor / 100)}`
                            : 'Any amount'}
                        </span>
                        <span className="text-muted">→ {policy.required_role.replace(/_/g, ' ')}</span>
                        {policy.audience === 'client' ? (
                          <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-muted">
                            client
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted">
                        {policy.sla_hours}h to answer
                        {policy.note ? ` · ${policy.note}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {decided.length > 0 ? (
        <Card>
          <CardHeader title="Recent decisions" description="Settled requests, newest first — who decided, what they said, and how long it waited." />
          <ul className="divide-y divide-line">
            {decided.slice(0, 20).map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={statusTone(r.state)}>{humanize(r.state)}</Badge>
                    <Link href={`/approvals/${r.id}`} className="text-[13px] font-medium hover:underline">
                      {r.summary ?? `${humanize(r.subject_type)} approval`}
                    </Link>
                  </span>
                  {r.decision_note ? <span className="text-xs text-muted">“{r.decision_note}”</span> : null}
                </div>
                <span className="text-xs text-muted">
                  {r.decided_at ? clock.dateTime(r.decided_at) : 'expired'} · asked {clock.date(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
