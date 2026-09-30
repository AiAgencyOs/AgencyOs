import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import {
  DELIVERY_LABEL,
  filterRequirements,
  groupByModule,
  requirementKpis,
  STATUS_LABEL,
  type RequirementFilter,
  type RequirementRow,
  type RequirementStatus,
} from '@/modules/projects/requirements-tab';
import { readAttachableFiles, readProjectRequirements, readRequirementComments } from '@/modules/projects/requirements-tab-queries';
import { PRIORITY_LABEL, PRIORITY_TONE } from '@/modules/projects/requirement-plan-schema';
import { listInternalRoster } from '@/modules/projects/queries';
import { Badge, buttonClass, Card, CardHeader, cx, DomainSearch, EmptyState, IconAttach, IconCheck, IconClock, IconFile, IconList, IconPlus, IconRefresh, IconTarget, PermissionDenied, Stat, StatGrid, type Tone, ViewAll } from '@/ui';

import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';
import { RequirementCommentForm } from './requirement-comment-form';
import { AttachFileForm, DetachFileButton, RequirementPlanForm } from './requirement-plan-forms';

export const metadata: Metadata = { title: 'Project requirements' };

const STATUS_TONE: Record<RequirementStatus, Tone> = { approved: 'success', in_review: 'warning', optional: 'info', excluded: 'neutral' };
const FILTERS: { key: RequirementFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'approved', label: 'Approved' },
  { key: 'in_review', label: 'In Review' },
  { key: 'not_started', label: 'Not Started' },
];

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '0%');

/**
 * The project Requirements tab (reference images 29 and 41): the requirement
 * list grouped by module, and the detail rail for the one selected. A
 * requirement is a scope item of the project's active scope version (or of
 * the open draft) — the same rows the Scope tab drafts and freezes, so this
 * tab adds no second list. Editing a requirement, and adding one, is drafting
 * scope, so those go to the Scope tab; comments are the one write here and
 * take their own door (`projects.comment_on_scope_item`).
 */
export default async function ProjectRequirementsPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ req?: string; status?: string; q?: string }> }) {
  const { projectId } = await params;
  const { req, status, q: qRaw } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/requirements`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [{ rows, openChangeRequests, activeVersion, draftVersion }, clock, clientName] = await Promise.all([
    readProjectRequirements(projectId),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);

  const q = (qRaw ?? '').trim().slice(0, 120);
  const filter: RequirementFilter = FILTERS.some((f) => f.key === status) ? (status as RequirementFilter) : 'all';
  const shown = filterRequirements(rows, filter, q);
  const selected: RequirementRow | null = rows.find((r) => r.id === req) ?? shown[0] ?? null;
  const [comments, attachable, roster] = await Promise.all([selected ? readRequirementComments(selected.id) : Promise.resolve([]), selected ? readAttachableFiles(projectId) : Promise.resolve([]), listInternalRoster()]);
  const kpis = requirementKpis(rows, openChangeRequests);
  const mayDraftScope = can(context, 'milestone.write');
  const mayComment = can(context, 'task.write');

  const base = `/projects/${projectId}/requirements`;
  const href = (over: { req?: string; status?: RequirementFilter }) => {
    const p = new URLSearchParams();
    const nextStatus = over.status ?? filter;
    if (nextStatus !== 'all') p.set('status', nextStatus);
    if (q) p.set('q', q);
    if (over.req) p.set('req', over.req);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader
        project={project}
        clock={clock}
        clientName={clientName}
        canEdit={can(context, 'project.write')}
        actions={
          mayDraftScope ? (
            <Link href={`/projects/${projectId}/scope`} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-3 text-[13px] font-medium text-background shadow-xs hover:opacity-90">
              <IconPlus size={14} />
              Add Requirement
            </Link>
          ) : null
        }
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={5}>
        <Stat label="Total Requirements" value={String(kpis.total)} caption={activeVersion !== null ? `Scope v${activeVersion}${draftVersion !== null ? ` · draft v${draftVersion}` : ''}` : 'No scope frozen yet'} tone="brand" icon={<IconFile size={16} />} />
        <Stat label="Approved" value={String(kpis.approved)} caption={`${pct(kpis.approved, kpis.total)} of the list`} tone="success" icon={<IconCheck size={16} />} />
        <Stat label="In Review" value={String(kpis.inReview)} caption={`${pct(kpis.inReview, kpis.total)} · on the open draft`} tone="warning" icon={<IconClock size={16} />} />
        <Stat label="Changes Requested" value={String(kpis.changesRequested)} caption="Open change requests" tone={kpis.changesRequested > 0 ? 'danger' : 'neutral'} icon={<IconRefresh size={16} />} href={`/projects/${projectId}/scope`} />
        <Stat label="Not Started" value={String(kpis.notStarted)} caption={`${pct(kpis.notStarted, kpis.total)} · no delivery begun`} tone="neutral" icon={<IconTarget size={16} />} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(20rem,1fr)]">
        <Card>
          <CardHeader
            title="Requirements List"
            description="Define, track and manage all project requirements"
            actions={<ViewAll href={`/projects/${projectId}/scope`} label="Open Scope" />}
          />
          <div className="flex flex-col gap-3 px-4 pb-3 sm:px-5">
            <DomainSearch action={base} value={q} placeholder="Search requirements…" label="Search requirements" preserve={{ status: filter === 'all' ? undefined : filter }} />
            <nav aria-label="Requirement status" className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => {
                const n = f.key === 'all' ? rows.length : filterRequirements(rows, f.key, '').length;
                return (
                  <Link
                    key={f.key}
                    href={href({ status: f.key })}
                    aria-current={f.key === filter ? 'page' : undefined}
                    className={cx('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[13px] font-medium', f.key === filter ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-foreground')}
                  >
                    {f.label}
                    <span className="tabular rounded-full bg-surface-sunken px-1.5 text-[11px]">{n}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          {rows.length === 0 ? (
            <EmptyState
              icon={<IconList size={22} />}
              title="No requirements yet"
              description="A requirement is an item of the project's scope. Draft the scope and each item appears here with its acceptance criteria."
              action={
                <Link href={`/projects/${projectId}/scope`} className={buttonClass('secondary', 'sm')}>
                  Open Scope
                </Link>
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState
              icon={<IconList size={22} />}
              title="No requirement matches"
              description="Nothing in the list fits that filter."
              action={
                <Link href={base} className={buttonClass('secondary', 'sm')}>
                  Clear filters
                </Link>
              }
            />
          ) : (
            <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
              {groupByModule(shown).map((g, gi) => (
                <details key={g.module} open={gi < 4 || g.rows.some((r) => r.id === selected?.id)} className="rounded-lg border border-line">
                  <summary className="flex cursor-pointer items-center gap-2 bg-surface-sunken px-3 py-2 text-[13px] font-semibold">
                    {g.module}
                    <span className="tabular rounded-full bg-surface px-1.5 text-[11px] font-medium text-muted">{g.rows.length}</span>
                  </summary>
                  <ul className="divide-y divide-line">
                    {g.rows.map((r) => (
                      <li key={r.id}>
                        <Link
                          href={href({ req: r.id })}
                          aria-current={r.id === selected?.id ? 'true' : undefined}
                          className={cx('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[13px] hover:bg-surface-hover', r.id === selected?.id && 'bg-brand-soft/40')}
                        >
                          <span className="w-16 shrink-0 font-mono text-xs text-brand">{r.code}</span>
                          <span className="min-w-0 flex-1 basis-40 font-medium text-foreground">{r.title}</span>
                          <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                          <span className="w-16">{r.priority ? <Badge tone={PRIORITY_TONE[r.priority]}>{PRIORITY_LABEL[r.priority]}</Badge> : <span className="text-xs text-muted">—</span>}</span>
                          <span className="w-28 truncate text-xs text-muted" title={r.assignee?.name}>{r.assignee?.name ?? 'Unassigned'}</span>
                          <span className="inline-flex w-10 items-center justify-end gap-0.5 text-xs text-muted" title={`${r.files.length} attached file${r.files.length === 1 ? '' : 's'}`}>{r.files.length > 0 ? <><IconAttach size={12} />{r.files.length}</> : null}</span>
                          <span className="w-24 text-xs text-muted">{r.delivery ? DELIVERY_LABEL[r.delivery] : 'Not planned'}</span>
                          <span className="w-24 text-right text-xs text-muted">{clock.date(r.createdAt)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {selected ? (
            <>
              <Card>
                <CardHeader
                  title="Requirement Details"
                  actions={
                    mayDraftScope ? (
                      <Link href={`/projects/${projectId}/scope`} className={buttonClass('secondary', 'sm')}>
                        Edit
                      </Link>
                    ) : null
                  }
                />
                <div className="flex flex-col gap-4 px-4 pb-4 sm:px-5">
                  <div>
                    <p className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono font-semibold text-muted">{selected.code}</span>
                      <Badge tone={STATUS_TONE[selected.status]}>{STATUS_LABEL[selected.status]}</Badge>
                      {selected.module ? <Badge tone="brand">{selected.module}</Badge> : null}
                    </p>
                    <h3 className="mt-1 text-lg font-bold tracking-tight">{selected.title}</h3>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
                    <div><dt className="text-xs text-muted">Inclusion</dt><dd className="font-medium capitalize">{selected.inclusion}</dd></div>
                    <div><dt className="text-xs text-muted">Scope version</dt><dd className="font-medium">v{selected.version}{selected.versionStatus === 'draft' ? ' (draft)' : ''}</dd></div>
                    <div><dt className="text-xs text-muted">Priority</dt><dd className="font-medium">{selected.priority ? <Badge tone={PRIORITY_TONE[selected.priority]}>{PRIORITY_LABEL[selected.priority]}</Badge> : <span className="font-normal text-muted">Not set</span>}</dd></div>
                    <div><dt className="text-xs text-muted">Assignee</dt><dd className="font-medium">{selected.assignee ? selected.assignee.name : <span className="font-normal text-muted">Unassigned</span>}</dd></div>
                    <div><dt className="text-xs text-muted">Delivery</dt><dd className="font-medium">{selected.delivery ? DELIVERY_LABEL[selected.delivery] : 'Not planned'}</dd></div>
                    <div><dt className="text-xs text-muted">Created</dt><dd className="font-medium">{clock.date(selected.createdAt)}</dd></div>
                  </dl>
                  <section>
                    <h4 className="text-[13px] font-bold">Description</h4>
                    <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{selected.detail?.trim() || 'No description was written for this requirement.'}</p>
                  </section>
                  <section>
                    <h4 className="text-[13px] font-bold">Acceptance Criteria</h4>
                    {selected.criteria.length === 0 ? (
                      <p className="mt-1 text-[13px] text-muted">No acceptance criteria recorded.{selected.inclusion === 'included' ? ' A frozen scope needs them on every included item.' : ''}</p>
                    ) : (
                      <ul className="mt-1.5 flex flex-col gap-1.5 text-[13px]">
                        {selected.criteria.map((c, i) => (
                          <li key={`${i}-${c}`} className="flex items-start gap-2">
                            <span aria-hidden className="mt-1 h-3.5 w-3.5 shrink-0 rounded-[4px] border border-line-strong" />
                            <span>{c}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              </Card>

              <Card>
                <CardHeader title="Plan and Attachments" description="Kept beside the frozen scope, so they stay editable after the freeze. The wording never changes." />
                <div className="flex flex-col gap-4 px-4 pb-4 sm:px-5">
                  {mayComment ? (
                    <RequirementPlanForm projectId={projectId} scopeItemId={selected.id} priority={selected.priority} assigneeId={selected.assignee?.userId ?? null} roster={roster.map((p) => ({ userId: p.userId, fullName: p.fullName }))} />
                  ) : (
                    <p className="text-xs text-muted">Changing priority, assignee and attachments takes the task.write permission.</p>
                  )}
                  <section aria-label="Attachments">
                    <h4 className="text-[13px] font-bold">Attachments ({selected.files.length})</h4>
                    {selected.files.length === 0 ? (
                      <p className="mt-1 text-[13px] text-muted">No file is attached. Attach one of the project&apos;s files below.</p>
                    ) : (
                      <ul className="mt-1.5 flex flex-col gap-1.5 text-[13px]">
                        {selected.files.map((f) => (
                          <li key={f.fileId} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5">
                            {f.url ? (
                              <a href={f.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate font-medium text-brand hover:underline">{f.title}</a>
                            ) : (
                              <Link href={`/projects/${projectId}/files`} className="min-w-0 truncate font-medium text-brand hover:underline">{f.title}</Link>
                            )}
                            {mayComment ? <DetachFileButton projectId={projectId} scopeItemId={selected.id} fileId={f.fileId} title={f.title} /> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {mayComment ? (
                      <div className="mt-2">
                        <AttachFileForm projectId={projectId} scopeItemId={selected.id} choices={attachable.filter((f) => !selected.files.some((a) => a.fileId === f.id))} />
                      </div>
                    ) : null}
                  </section>
                </div>
              </Card>

              <Card>
                <CardHeader title="Related Items" />
                <ul className="flex flex-col divide-y divide-line px-4 pb-3 text-[13px] sm:px-5">
                  <li className="flex items-baseline justify-between gap-3 py-2">
                    <span className="text-muted">Design Screens</span>
                    <span className="text-right font-medium">{selected.screens.length === 0 ? '—' : selected.screens.map((s) => s.name).join(', ')}</span>
                  </li>
                  <li className="flex items-baseline justify-between gap-3 py-2">
                    <span className="text-muted">Test Cases</span>
                    <Link href={`/projects/${projectId}/qa`} className="font-medium text-brand hover:underline">{selected.testCases}</Link>
                  </li>
                  <li className="flex items-baseline justify-between gap-3 py-2">
                    <span className="text-muted">Plan Deliverables</span>
                    <span className="text-right font-medium">{selected.deliverables.length === 0 ? '—' : selected.deliverables.map((d) => d.name).join(', ')}</span>
                  </li>
                </ul>
              </Card>

              <Card>
                <CardHeader title={`Comments (${comments.length})`} />
                <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                  {comments.length === 0 ? (
                    <p className="text-[13px] text-muted">No comment yet.</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {comments.map((c) => (
                        <li key={c.id} className="rounded-lg border border-line px-3 py-2 text-[13px]">
                          <p className="flex flex-wrap items-baseline gap-2 text-xs text-muted">
                            <span className="font-semibold text-foreground">{c.authorName}</span>
                            {clock.dateTime(c.createdAt)}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  {mayComment ? <RequirementCommentForm projectId={projectId} scopeItemId={selected.id} /> : <p className="text-xs text-muted">Commenting takes the task.write permission.</p>}
                </div>
              </Card>
            </>
          ) : (
            <Card>
              <CardHeader title="Requirement Details" />
              <EmptyState
                icon={<IconFile size={22} />}
                title="Nothing selected"
                description="Pick a requirement in the list to read its description, acceptance criteria and comments."
                action={
                  <Link href={`/projects/${projectId}/scope`} className={buttonClass('secondary', 'sm')}>
                    Open Scope
                  </Link>
                }
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
