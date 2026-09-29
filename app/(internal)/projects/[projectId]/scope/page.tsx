import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readChangeRequestContext } from '@/modules/projects/change-request-queries';
import { getProject, listScopeVersionHistory, readChangeRequests, readScopeBaseline } from '@/modules/projects/queries';
import { readRevisionAllowance, readScopeDrift, readScopeQuoteLinks } from '@/modules/projects/scope-insight-queries';
import { Badge, Card, EmptyState, humanize, IconProjects, PageHeader, Stat, StatGrid, statusTone } from '@/ui';

import { ChangeRequestList, SubmitChangeRequestForm } from '../change-request-panel';
import { OpenScopeVersionForm, ScopeVersionCard, type FreezeCheck } from '../scope-panel';
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
  const [{ active, draft }, changeRequests, history, quoteLinks, drift, allowance] = await Promise.all([
    readScopeBaseline(projectId),
    readChangeRequests(projectId),
    listScopeVersionHistory(projectId),
    readScopeQuoteLinks(projectId),
    readScopeDrift(projectId),
    readRevisionAllowance(projectId),
  ]);
  const supersededHistory = history.filter((v) => v.status === 'superseded');
  const canWrite = can(context.role, 'milestone.write');
  // SCR-031 — the payment gate, linked tasks and the quotation door per
  // change request. Invoice status is read only for a role RLS lets read it;
  // otherwise the gate says so rather than showing "no invoice".
  const crContext = await readChangeRequestContext(projectId, { includeInvoices: can(context.role, 'invoice.read') });

  // SCR-030's freeze checklist — the three things a person can fix before
  // the door refuses. Computed from reads this page already made.
  const openOnDraft = draft
    ? changeRequests.filter((cr) => cr.scopeVersionId === draft.id && !['rejected', 'closed', 'implemented'].includes(cr.status))
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
  const quoteFor = (scopeVersionId: string) => quoteLinks.find((q) => q.scopeVersionId === scopeVersionId)?.proposals ?? [];
  const activeQuote = active ? (quoteFor(active.id)[0] ?? null) : null;
  const allowanceValue = (a: { used: number; limit: number } | null) => (a ? `${a.used} / ${a.limit}` : '—');
  const allowanceTone = (a: { used: number; limit: number } | null) =>
    !a ? 'neutral' : a.used >= a.limit ? 'danger' : a.used + 1 >= a.limit ? 'warning' : 'success';
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

      {/*
        SCR-030 — what the tab could not say about its own baseline. The
        revision counts are read as stored (the database refuses the round
        past the limit; this only shows how close the project is), and the
        quotation is the one citing the same requirement version the baseline
        descends from.
      */}
      <StatGrid>
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
        <Stat
          label="Design revision rounds"
          value={allowanceValue(allowance.design)}
          tone={allowanceTone(allowance.design)}
          caption="client rounds used of the Phase 3 limit"
        />
        <Stat label="UI revision rounds" value={allowanceValue(allowance.ui)} tone={allowanceTone(allowance.ui)} caption="of the Phase 4 limit" />
        <Stat
          label="Prototype revision rounds"
          value={allowanceValue(allowance.prototype)}
          tone={allowanceTone(allowance.prototype)}
          caption="of the Phase 4 limit"
        />
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
                  <Badge tone={r.status === 'implemented' ? 'success' : 'warning'}>{r.status}</Badge>
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
          context={crContext}
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
