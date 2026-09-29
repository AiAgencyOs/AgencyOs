import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listScopeItemsForVersion, listScopeVersionHistory, readChangeRequests, readScopeBaseline, type ScopeItemRow } from '@/modules/projects/queries';
import Link from 'next/link';

import { Badge, Card, CardHeader, EmptyState, humanize, IconCheck, IconClock, IconFlag, IconProjects, PageHeader, Stat, StatGrid, statusTone, PermissionDenied } from '@/ui';

import { ChangeRequestList, SubmitChangeRequestForm } from '../change-request-panel';
import { OpenScopeVersionForm, ScopeVersionCard } from '../scope-panel';
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
export default async function ScopePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ compare?: string }> }) {
  const { projectId } = await params;
  const { compare } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/scope`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const [{ active, draft }, changeRequests, history] = await Promise.all([
    readScopeBaseline(projectId),
    readChangeRequests(projectId),
    listScopeVersionHistory(projectId),
  ]);
  const supersededHistory = history.filter((v) => v.status === 'superseded');

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
  const canWrite = can(context.role, 'milestone.write');
  // Matches the door's own core.is_owner() gate for decide_change_request —
  // see change-request-panel.tsx's header comment for why this stays
  // separate from canWrite.
  const isOwner = context.role === 'owner';

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

      <StatGrid cols={5}>
        <Stat label="Frozen baseline" value={active ? `v${active.version}` : '—'} caption={active ? `${scopeIn} in · ${scopeOut} out of scope` : draft ? 'Draft open, nothing frozen yet' : 'No baseline'} tone="brand" icon={<IconFlag size={16} />} />
        <Stat label="Open change requests" value={String(crOpen.length)} caption={crAwaitingOwner.length > 0 ? `${crAwaitingOwner.length} awaiting an owner` : 'None waiting on a decision'} tone={crOpen.length > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} />
        <Stat label="Approved, not applied" value={String(crApproved.length)} caption="Apply to open the next draft" tone={crApproved.length > 0 ? 'info' : 'neutral'} icon={<IconCheck size={16} />} />
        <Stat label="Applied" value={String(crApplied.length)} caption={`${crRejected.length} rejected`} tone="success" icon={<IconCheck size={16} />} />
        <Stat label="Captured impact" value={crEffort > 0 ? `${crEffort}h` : '—'} caption={crDays > 0 ? `+${crDays} day${crDays === 1 ? '' : 's'} to the timeline` : 'No estimates recorded'} tone="accent" icon={<IconClock size={16} />} />
      </StatGrid>

      {draft ? <ScopeVersionCard projectId={projectId} scopeVersion={draft} editable={canWrite} /> : null}

      {active ? (
        <ScopeVersionCard projectId={projectId} scopeVersion={active} editable={false} />
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
        <ChangeRequestList
          projectId={projectId}
          changeRequests={changeRequests}
          mayManage={canWrite}
          mayDecide={isOwner}
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
