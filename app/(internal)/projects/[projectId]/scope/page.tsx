import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listScopeVersionHistory, readChangeRequests, readScopeBaseline } from '@/modules/projects/queries';
import { Badge, Card, EmptyState, humanize, IconCheck, IconClock, IconFlag, IconProjects, PageHeader, Stat, StatGrid, statusTone, PermissionDenied } from '@/ui';

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
export default async function ScopePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

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
                  <span className="text-xs text-muted">
                    {v.frozenAt ? `Frozen ${clock.date(v.frozenAt)}` : `Opened ${clock.date(v.createdAt)}`}
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
