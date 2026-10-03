import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { readChangeRequestInvoices } from '@/modules/projects/change-request-invoice-queries';
import { readChangeRequestContext } from '@/modules/projects/change-request-queries';
import { readScopeApprovals } from '@/modules/projects/scope-approval-queries';

import { ScopeApprovalPanel } from './approval-form';
import { getProject, listScopeItemsForVersion, listScopeVersionHistory, readChangeRequests, readScopeBaseline, type ScopeItemRow } from '@/modules/projects/queries';
import { readRevisionAllowance, readScopeDrift, readScopeQuoteLinks } from '@/modules/projects/scope-insight-queries';
import Link from 'next/link';

import { CHANGE_REQUEST_CLASSIFICATIONS } from '@/modules/projects/schema';
import { DEFAULT_REVISION_LIMIT } from '@/modules/projects/scope-insight-queries';
import { Badge, buttonClass, Card, CardHeader, EmptyState, humanize, labelClass, selectClass, IconCheck, IconClock, IconFlag, IconProjects, PageHeader, Stat, StatGrid, statusTone, PermissionDenied } from '@/ui';

import { ChangeRequestList, SubmitChangeRequestForm } from '../change-request-panel';
import { OpenScopeVersionForm, ScopeVersionCard, type FreezeCheck } from '../scope-panel';
import { UnfreezeScopeVersionForm } from './unfreeze-form';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Scope' };

/**
 * The scope baseline (Doc 11 §3, §29) — Requirements & Scope's core screen
 * (SCR-030), plus its change-request queue (SCR-031; G-311). Every accepted
 * requirement becomes a frozen scope version that QA's test plan and a change
 * request both cite by foreign key, so "is this in scope" has one answer.
 * Gated on project.read for viewing, milestone.write for the scope writes and
 * for classifying/applying a change request (re-checked server-side by the
 * actions); deciding one is stricter still — owner only, matching the door's
 * own `core.is_owner()` check.
 */
export default async function ScopePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ compare?: string; crStatus?: string; crClass?: string }> }) {
  const { projectId } = await params;
  const { compare, crStatus, crClass } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/scope`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const [{ active, draft }, changeRequests, history, quoteLinks, drift, allowance] = await Promise.all([
    readScopeBaseline(projectId),
    readChangeRequests(projectId),
    listScopeVersionHistory(projectId),
    readScopeQuoteLinks(projectId),
    readScopeDrift(projectId),
    readRevisionAllowance(projectId),
  ]);
  const supersededHistory = history.filter((v) => v.status === 'superseded');
  // SCR-031 — the payment gate, linked tasks and the quotation door per
  // change request. Invoice status is read only for a role RLS lets read it;
  // otherwise the gate says so rather than showing "no invoice".
  const crContext = await readChangeRequestContext(projectId, { includeInvoices: can(context, 'invoice.read') });
  // SCR-030 approval evidence per version; SCR-031 each request's OWN invoice
  // (20261001120000) and the client thread a quotation is sent on.
  const [approvals, crInvoices] = await Promise.all([readScopeApprovals(projectId), readChangeRequestInvoices(projectId, { includeInvoices: can(context, 'invoice.read') })]);

  // SCR-030's freeze checklist — the three things a person can fix before
  // the door refuses. Computed from reads this page already made.
  const openOnDraft = draft
    ? changeRequests.filter((cr) => cr.scopeVersionId === draft.id && !['rejected', 'closed', 'implemented', 'applied'].includes(cr.status))
    : [];
  const freezeChecklist: FreezeCheck[] = draft
    ? [
        { label: 'At least one item is marked included', ok: draft.items.some((i) => i.inclusion === 'included') },
        {
          label: 'Every included item has acceptance criteria',
          ok: draft.items.filter((i) => i.inclusion === 'included').every((i) => Boolean(i.acceptanceCriteria?.trim())),
        },
        {
          label:
            openOnDraft.length === 0
              ? 'No change request is open against this draft'
              : `${openOnDraft.length} change request${openOnDraft.length === 1 ? '' : 's'} still open against this draft`,
          ok: openOnDraft.length === 0,
        },
      ]
    : [];
  const activeQuote = active ? (quoteLinks.find((q) => q.scopeVersionId === active.id)?.proposals[0] ?? null) : null;
  // SCR-030/031 "Revision allowance usage": used / limit as stored on the phase row. Before the phase
  // opens there is no row, so the tile says so and shows the limit the database gives a new phase (3).
  const allowanceValue = (a: { used: number; limit: number } | null) => (a ? `${a.used} / ${a.limit}` : `0 / ${DEFAULT_REVISION_LIMIT}`);
  const allowanceTone = (a: { used: number; limit: number } | null) =>
    !a ? 'neutral' : a.used >= a.limit ? 'danger' : a.used + 1 >= a.limit ? 'warning' : 'success';
  const allowanceCaption = (a: { used: number; limit: number } | null, what: string, phase: string) =>
    a ? `${what} of the ${phase} limit · ${Math.max(0, a.limit - a.used)} left` : `${phase} has not started · ${DEFAULT_REVISION_LIMIT} rounds once it opens`;

  // SCR-029's compare: one earlier version beside the current baseline,
  // item by item, matched on title. Nothing is inferred about *why* an item
  // moved — the change request that did it is listed above.
  const compareVersion = compare ? (history.find((v) => v.id === compare) ?? null) : null;
  const current = active ?? draft ?? null;
  const compareItems = compareVersion ? await listScopeItemsForVersion(compareVersion.id) : [];
  const diff = (() => {
    if (!compareVersion || !current) return null;
    const key = (i: ScopeItemRow) => i.title.trim().toLowerCase();
    const was = new Map(compareItems.map((i) => [key(i), i]));
    const now = new Map(current.items.map((i) => [key(i), i]));
    const added = current.items.filter((i) => !was.has(key(i)));
    const removed = compareItems.filter((i) => !now.has(key(i)));
    const changed = current.items
      .filter((i) => was.has(key(i)))
      .map((i) => ({ before: was.get(key(i)) as ScopeItemRow, after: i }))
      .filter(({ before, after }) => before.inclusion !== after.inclusion || (before.detail ?? '') !== (after.detail ?? '') || (before.acceptanceCriteria ?? '') !== (after.acceptanceCriteria ?? ''));
    return { added, removed, changed, unchanged: current.items.length - added.length - changed.length };
  })();
  const canWrite = can(context, 'milestone.write');
  // Matches the door's own core.is_owner() gate for decide_change_request —
  // see change-request-panel.tsx's header comment for why this stays
  // separate from canWrite.
  const isOwner = hasRole(context, 'owner');

  const shownRequests = changeRequests.filter((cr) => (!crStatus || cr.status === crStatus) && (!crClass || cr.classification === crClass));
  const crOpen = changeRequests.filter((cr) => ['submitted', 'analysing', 'classified', 'pending_approval'].includes(cr.status));
  const crAwaitingOwner = changeRequests.filter((cr) => ['classified', 'pending_approval'].includes(cr.status));
  const crApproved = changeRequests.filter((cr) => cr.status === 'approved');
  const crApplied = changeRequests.filter((cr) => cr.status === 'applied');
  const crRejected = changeRequests.filter((cr) => cr.status === 'rejected');
  const crEffort = changeRequests.filter((cr) => cr.status !== 'rejected').reduce((n, cr) => n + (cr.effortHours ?? 0), 0);
  const crDays = changeRequests.filter((cr) => cr.status !== 'rejected').reduce((n, cr) => n + (cr.timelineDays ?? 0), 0);
  const scopeIn = active?.items.filter((i) => i.inclusion === 'included').length ?? 0;
  const scopeOut = active?.items.filter((i) => i.inclusion === 'excluded').length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Scope`}
        description="The frozen baseline everything downstream — the test plan, a change request — is measured against."
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={6}>
        <Stat label="Frozen baseline" value={active ? `v${active.version}` : '—'} caption={active ? `${scopeIn} in · ${scopeOut} out of scope` : draft ? 'Draft open, nothing frozen yet' : 'No baseline'} tone="brand" icon={<IconFlag size={16} />} />
        <Stat label="Open change requests" value={String(crOpen.length)} caption="submitted, analysing, classified or pending" tone={crOpen.length > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} />
        <Stat label="Awaiting approval" value={String(crAwaitingOwner.length)} caption={crAwaitingOwner.length > 0 ? 'classified, waiting on an owner' : 'None waiting on a decision'} tone={crAwaitingOwner.length > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} />
        <Stat label="Approved, not applied" value={String(crApproved.length)} caption="Apply to open the next draft" tone={crApproved.length > 0 ? 'info' : 'neutral'} icon={<IconCheck size={16} />} />
        <Stat label="Applied" value={String(crApplied.length)} caption="opened the next scope draft" tone="success" icon={<IconCheck size={16} />} />
        <Stat label="Rejected" value={String(crRejected.length)} caption="declined by an owner" tone={crRejected.length > 0 ? 'danger' : 'neutral'} icon={<IconClock size={16} />} />
        <Stat label="Captured impact" value={crEffort > 0 ? `${crEffort}h` : '—'} caption={crDays > 0 ? `+${crDays} day${crDays === 1 ? '' : 's'} to the timeline` : 'No estimates recorded'} tone="accent" icon={<IconClock size={16} />} />
      </StatGrid>

      {/*
        SCR-030 — the quotation the baseline descends from, and the revision
        allowance as stored. The database refuses the round past the limit;
        this only shows how close the project is.
      */}
      <StatGrid cols={4}>
        <Stat
          label="Linked quotation"
          value={activeQuote ? `${activeQuote.title} v${activeQuote.version}` : active ? 'none cites this baseline' : '—'}
          caption={
            activeQuote
              ? humanize(activeQuote.status)
              : active
                ? 'the baseline names no requirement version a quotation prices'
                : 'no active baseline'
          }
          href={activeQuote ? `/quotations?status=${encodeURIComponent(activeQuote.status)}` : undefined}
        />
        <Stat label="Design revision rounds" value={allowanceValue(allowance.design)} tone={allowanceTone(allowance.design)} caption={allowanceCaption(allowance.design, 'client rounds used', 'Phase 3')} />
        <Stat label="UI revision rounds" value={allowanceValue(allowance.ui)} tone={allowanceTone(allowance.ui)} caption={allowanceCaption(allowance.ui, 'rounds used', 'Phase 4')} />
        <Stat label="Prototype revision rounds" value={allowanceValue(allowance.prototype)} tone={allowanceTone(allowance.prototype)} caption={allowanceCaption(allowance.prototype, 'rounds used', 'Phase 4')} />
      </StatGrid>

      {drift && (drift.appliedRequests.length > 0 || drift.added.length > 0 || drift.removed.length > 0) ? (
        <Card className="flex flex-col gap-2 p-4 sm:p-5">
          <h2 className="text-[13px] font-semibold tracking-tight">Drift from the frozen baseline</h2>
          <p className="max-w-2xl text-[13px] text-muted">
            What was agreed and what is about to replace it are two different lists until the next version freezes.
          </p>
          {drift.appliedRequests.length > 0 ? (
            <ul className="flex flex-col gap-1 text-[13px]">
              {drift.appliedRequests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.status === 'approved' ? 'warning' : 'success'}>{r.status}</Badge>
                  <span className="line-clamp-1">“{r.requested}”</span>
                  {r.resultingVersion !== null ? <span className="text-xs text-muted">→ v{r.resultingVersion}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {drift.draftOpenedBy ? (
            <p className="text-xs text-muted">The open draft was opened by the change request “{drift.draftOpenedBy.requested}”.</p>
          ) : null}
          {drift.added.length > 0 ? (
            <p className="text-[13px]">
              <span className="text-muted">Added in the draft: </span>
              {drift.added.join(', ')}
            </p>
          ) : null}
          {drift.removed.length > 0 ? (
            <p className="text-[13px]">
              <span className="text-muted">Dropped from the baseline: </span>
              {drift.removed.join(', ')}
            </p>
          ) : null}
        </Card>
      ) : null}

      {draft ? (
        <ScopeVersionCard projectId={projectId} scopeVersion={draft} editable={canWrite} freezeChecklist={freezeChecklist} />
      ) : null}

      {active ? (
        <>
          <ScopeVersionCard projectId={projectId} scopeVersion={active} editable={false} />
          {/* SCR-030 "Approval evidence": who approved the frozen baseline and where the evidence lives. */}
          <ScopeApprovalPanel
            projectId={projectId}
            scopeVersionId={active.id}
            version={active.version}
            approval={approvals[active.id] ?? null}
            approvedLabel={approvals[active.id]?.approvedAt ? clock.dateTime(approvals[active.id]!.approvedAt as string) : null}
            editable={canWrite}
          />
          {/* SCR-030: the owner's unfreeze override, offered only when v{active}
              is the newest version — the door refuses `later_version_exists`
              otherwise, and a draft is by definition a later version. */}
          {isOwner && !draft ? (
            <UnfreezeScopeVersionForm projectId={projectId} scopeVersionId={active.id} version={active.version} />
          ) : null}
        </>
      ) : !draft ? (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="No scope baseline yet"
          description="Open a draft, add what is in and out of scope, then freeze it once it is complete."
        />
      ) : null}

      {canWrite && !draft ? <OpenScopeVersionForm projectId={projectId} /> : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[13px] font-semibold tracking-tight">Change requests</h2>
          <p className="max-w-2xl text-[13px] text-muted">
            Doc 11 §16–§22. A client-sourced scope escalation from Phase 3 opens one of these
            automatically; classify it, then only an owner may approve or reject it, and an approved
            request opens the next scope draft.
          </p>
        </div>
        {canWrite ? <SubmitChangeRequestForm projectId={projectId} /> : null}
        {/* SCR-031 search/filter: narrow the list by status or classification; a URL somebody can send. */}
        {changeRequests.length > 1 ? (
          <form method="GET" action={`/projects/${projectId}/scope`} className="flex flex-wrap items-end gap-2" aria-label="Filter change requests">
            {compare ? <input type="hidden" name="compare" value={compare} /> : null}
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Status</span>
              <select name="crStatus" defaultValue={crStatus ?? ''} className={selectClass}>
                <option value="">Any status</option>
                {[...new Set(changeRequests.map((cr) => cr.status))].map((st) => (
                  <option key={st} value={st}>{humanize(st)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Classification</span>
              <select name="crClass" defaultValue={crClass ?? ''} className={selectClass}>
                <option value="">Any classification</option>
                {CHANGE_REQUEST_CLASSIFICATIONS.map((c) => (
                  <option key={c} value={c}>{humanize(c)}</option>
                ))}
              </select>
            </label>
            <button type="submit" className={buttonClass('secondary', 'sm')}>Filter</button>
            {crStatus || crClass ? <Link href={`/projects/${projectId}/scope`} className={buttonClass('ghost', 'sm')}>Clear</Link> : null}
            <span className="pb-2 text-xs text-muted">{shownRequests.length} of {changeRequests.length}</span>
          </form>
        ) : null}
        <ChangeRequestList
          projectId={projectId}
          changeRequests={shownRequests}
          mayManage={canWrite}
          mayDecide={isOwner}
          context={crContext}
          invoices={crInvoices}
          mayInvoice={can(context, 'invoice.create')}
          maySendQuotation={can(context, 'proposal.send')}
        />
      </section>

      {compareVersion && current && diff ? (
        <section id="compare" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h2 className="text-[13px] font-semibold tracking-tight">
                v{compareVersion.version} → v{current.version} ({current.status})
              </h2>
              <p className="max-w-2xl text-[13px] text-muted">
                Matched on title. {diff.added.length} added · {diff.removed.length} removed · {diff.changed.length} changed · {diff.unchanged} unchanged.
              </p>
            </div>
            <Link href={`/projects/${projectId}/scope`} className="text-xs text-muted hover:underline">Close</Link>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <Card>
              <CardHeader title={`Added (${diff.added.length})`} />
              <ul className="divide-y divide-line">
                {diff.added.length === 0 ? <li className="px-4 py-3 text-[13px] text-muted">Nothing added.</li> : null}
                {diff.added.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px]"><span>{i.title}</span><Badge tone={i.inclusion === 'included' ? 'success' : 'neutral'}>{i.inclusion}</Badge></li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardHeader title={`Removed (${diff.removed.length})`} />
              <ul className="divide-y divide-line">
                {diff.removed.length === 0 ? <li className="px-4 py-3 text-[13px] text-muted">Nothing removed.</li> : null}
                {diff.removed.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px]"><span className="line-through decoration-muted">{i.title}</span><Badge tone="neutral">{i.inclusion}</Badge></li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardHeader title={`Changed (${diff.changed.length})`} />
              <ul className="divide-y divide-line">
                {diff.changed.length === 0 ? <li className="px-4 py-3 text-[13px] text-muted">Nothing changed in place.</li> : null}
                {diff.changed.map(({ before, after }) => (
                  <li key={after.id} className="flex flex-col gap-1 px-4 py-2 text-[13px]">
                    <span className="font-medium">{after.title}</span>
                    {before.inclusion !== after.inclusion ? (
                      <span className="text-xs text-muted">Inclusion: <Badge tone="neutral">{before.inclusion}</Badge> → <Badge tone={after.inclusion === 'included' ? 'success' : 'warning'}>{after.inclusion}</Badge></span>
                    ) : null}
                    {(before.detail ?? '') !== (after.detail ?? '') ? <span className="text-xs text-muted">Detail: <span className="text-danger line-through">{before.detail ?? '—'}</span> → <span className="text-success">{after.detail ?? '—'}</span></span> : null}
                    {(before.acceptanceCriteria ?? '') !== (after.acceptanceCriteria ?? '') ? <span className="text-xs text-muted">Acceptance: <span className="text-danger line-through">{before.acceptanceCriteria ?? '—'}</span> → <span className="text-success">{after.acceptanceCriteria ?? '—'}</span></span> : null}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </section>
      ) : null}

      {supersededHistory.length > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-[13px] font-semibold tracking-tight">Version history</h2>
            <p className="max-w-2xl text-[13px] text-muted">
              Every earlier baseline, read-only once an approved change moved past it — what version 1
              actually said, if a scope dispute ever needs to check.
            </p>
          </div>
          <Card>
            <ul className="divide-y divide-line">
              {supersededHistory.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">v{v.version}</span>
                    <Badge tone={statusTone(v.status)}>{humanize(v.status)}</Badge>
                    <span className="text-xs text-muted">{v.itemCount} item{v.itemCount === 1 ? '' : 's'}</span>
                  </span>
                  <span className="flex items-center gap-3 text-xs text-muted">
                    {v.frozenAt ? `Frozen ${clock.date(v.frozenAt)}` : `Opened ${clock.date(v.createdAt)}`}
                    <Link href={`/projects/${projectId}/scope?compare=${v.id}#compare`} className={compare === v.id ? 'font-medium text-foreground' : 'text-brand hover:underline'}>
                      {compare === v.id ? 'Comparing' : 'Compare with current'}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
