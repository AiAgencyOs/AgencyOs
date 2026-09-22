import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listScopeVersionHistory, readChangeRequests, readScopeBaseline } from '@/modules/projects/queries';
import { Badge, Card, EmptyState, humanize, IconProjects, PageHeader, statusTone } from '@/ui';

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
  if (!can(context.role, 'project.read')) redirect('/dashboard');

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

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Scope`}
        description="The frozen baseline everything downstream — the test plan, a change request — is measured against."
      />

      <ProjectSubNav projectId={projectId} />

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
