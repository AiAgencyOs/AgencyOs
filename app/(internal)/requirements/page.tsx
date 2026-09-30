import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProposedRequirements } from '@/modules/crm/queries';
import { readRequirementsDashboard } from '@/lib/admin/requirements-dashboard';
import { readRequirementsOverview } from '@/modules/projects/queries';
import { listRequirementsProjectPlans, readRecentRequirementChanges } from '@/modules/projects/requirements-recent-queries';

import { RequirementsDoors } from './requirements-doors';
import {
  buttonClass,
  Avatar,
  Badge,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  IconCheck,
  IconClock,
  IconSparkle,
  IconUser,
  PageHeader,
  PermissionDenied,
  QuickActions,
  Stat,
  StatGrid,
  ViewAll,
  type Column,
} from '@/ui';

export const metadata: Metadata = { title: 'Requirements' };

/**
 * Requirements Dashboard — SCR-028, laid out as the reference's requirements
 * list: figures, the table with source and age, and a rail that says where
 * the decision is made. Every requirement version still awaiting a human
 * decision, across every lead. The decision itself stays on the lead's own
 * page (requirement-decision-form.tsx, which requires opening the specific
 * lead to reach) — this is the cross-lead view of what is waiting, oldest
 * first, so an owner does not have to check every lead to find the ones
 * nobody has answered.
 */
export default async function RequirementsPage() {
  const context = await requireInternal('/requirements');
  if (!can(context, 'lead.read')) return <PermissionDenied />;
  const clock = await agencyClock();

  const [proposed, overview, dashboard, recent, projectPlans] = await Promise.all([
    listProposedRequirements(),
    readRequirementsOverview(),
    readRequirementsDashboard(),
    // SCR-028: recent requirement changes across every project, and the live
    // plan per project for the clarification / change-request doors.
    readRecentRequirementChanges(),
    listRequirementsProjectPlans(),
  ]);
  const mayRaise = can(context, 'milestone.write');
  const openQuestionProjects = dashboard.projectsWithOpenQuestions.length;
  const now = Date.now();
  const ageDays = (iso: string) => Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  const fromAgent = proposed.filter((r) => r.source === 'agent').length;
  const stale = proposed.filter((r) => ageDays(r.createdAt) >= 3).length;
  const oldest = proposed[0] ? ageDays(proposed[0].createdAt) : null;

  type Row = (typeof proposed)[number];
  const columns: Column<Row>[] = [
    {
      key: 'lead',
      header: 'Lead',
      primary: true,
      cell: (r) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={r.leadTitle} size="md" />
          <span className="truncate">{r.leadTitle}</span>
        </span>
      ),
    },
    { key: 'version', header: 'Version', cellClassName: 'font-mono text-xs', cell: (r) => `v${r.version}` },
    { key: 'source', header: 'Source', badge: true, cell: (r) => <Badge tone={r.source === 'agent' ? 'brand' : 'neutral'}>{r.source === 'agent' ? 'AI extracted' : r.source}</Badge> },
    { key: 'status', header: 'Status', desktopOnly: true, cell: () => <Badge tone="warning" dot>Awaiting decision</Badge> },
    {
      key: 'age',
      header: 'Waiting',
      align: 'right',
      cellClassName: 'tabular whitespace-nowrap',
      cell: (r) => {
        const d = ageDays(r.createdAt);
        return <span className={d >= 3 ? 'font-medium text-danger' : 'text-muted'}>{d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'}`}</span>;
      },
    },
    { key: 'proposed', header: 'Proposed', align: 'right', desktopOnly: true, cellClassName: 'text-muted whitespace-nowrap', cell: (r) => clock.dateTime(r.createdAt) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Requirements" description="Define, track and decide every requirement version across all leads — oldest waiting first." />

      <StatGrid cols={5}>
        <Stat label="Awaiting decision" value={String(proposed.length)} caption="Across every lead" tone={proposed.length > 0 ? 'warning' : 'success'} icon={<IconClock size={16} />} />
        <Stat label="AI extracted" value={String(fromAgent)} caption={proposed.length > 0 ? `${Math.round((fromAgent / proposed.length) * 100)}% of the queue` : 'Nothing queued'} tone="brand" icon={<IconSparkle size={16} />} />
        <Stat label="Frozen scopes" value={String(overview.frozenScopes)} caption="Scope versions past draft" tone="success" icon={<IconCheck size={16} />} />
        <Stat label="Open change requests" value={String(overview.openChangeRequests)} caption={`${overview.pendingApprovalChangeRequests} awaiting approval`} tone={overview.openChangeRequests > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} href="/approvals" />
        <Stat label="Open clarifications" value={String(overview.openClarifications)} caption="Plan and UI questions not resolved" tone={overview.openClarifications > 0 ? 'info' : 'neutral'} icon={<IconSparkle size={16} />} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader title="Requirements List" description="Open the lead to read the version and accept or reject it." actions={<ViewAll href="/leads" label="All leads" />} />
          {proposed.length > 0 ? (
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={proposed} columns={columns} getKey={(r) => r.id} href={(r) => `/leads/${r.leadId}`} />
            </div>
          ) : (
            <EmptyState
              icon={<IconCheck size={22} />}
              title="Nothing awaiting a decision"
              description="A requirement version proposed by the agent or drafted by hand appears here until an owner accepts or rejects it."
              action={<Link href="/leads" className={buttonClass('secondary', 'sm')}>Open leads</Link>}
            />
          )}
        </Card>

        <Card>
        <CardHeader title="Requirement sets by project" description="The scope version each project works to, and what is open against it." />
        {overview.projects.length === 0 ? (
          <EmptyState title="No projects yet" action={<Link href="/projects" className={buttonClass('secondary', 'sm')}>Open projects</Link>} />
        ) : (
          <div className="px-4 pb-4 sm:px-5">
            <DataTable
              dense
              rows={overview.projects}
              getKey={(p) => p.projectId}
              href={(p) => `/projects/${p.projectId}/scope`}
              columns={[
                { key: 'project', header: 'Project', primary: true, cell: (p) => p.projectName },
                { key: 'scope', header: 'Scope version', cell: (p) => (p.scopeVersion === null ? <Badge tone="neutral">none</Badge> : <span className="flex items-center gap-1.5"><span className="font-mono text-xs">v{p.scopeVersion}</span><Badge tone={p.scopeStatus === 'active' ? 'success' : 'neutral'}>{p.scopeStatus ?? '—'}</Badge></span>) },
                { key: 'crs', header: 'Open change requests', align: 'right', cellClassName: 'tabular', cell: (p) => String(p.openChangeRequests) },
                { key: 'qs', header: 'Open clarifications', align: 'right', cellClassName: 'tabular', cell: (p) => String(p.openClarifications) },
              ]}
            />
          </div>
        )}
      </Card>

      {openQuestionProjects > 0 ? (
        <Card id="open-questions">
          <CardHeader
            title="Projects with open questions"
            description="A plan question nobody has settled, or a PM Agent clarification nobody has answered. The plan cannot activate, and the agent will not guess, until somebody does."
          />
          <ul className="divide-y divide-line">
            {dashboard.projectsWithOpenQuestions.map((p) => (
              <li key={p.projectId}>
                <Link
                  href={`/projects/${p.projectId}/plan`}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-[13px] hover:bg-surface-hover sm:px-5"
                >
                  <span className="font-medium">{p.projectName}</span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {p.planQuestions > 0 ? <Badge tone="warning">{p.planQuestions} on the plan</Badge> : null}
                    {p.pmQuestions > 0 ? <Badge tone="info">{p.pmQuestions} from the PM agent</Badge> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {dashboard.scopeDrift.length > 0 ? (
        <Card id="scope-drift">
          <CardHeader
            title="Scope drift"
            description="A change request raised against a frozen baseline and not yet settled. Until it is classified, decided and applied, what is being built and what was agreed are two different lists."
          />
          <ul className="divide-y divide-line">
            {dashboard.scopeDrift.map((cr) => (
              <li key={cr.changeRequestId}>
                <Link href={`/projects/${cr.projectId}/scope`} className="flex flex-col gap-1 px-4 py-3 text-[13px] hover:bg-surface-hover sm:px-5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{cr.projectName}</span>
                    <Badge tone="neutral">baseline v{cr.scopeVersion}</Badge>
                    <Badge tone="warning">{cr.status.replace(/_/g, ' ')}</Badge>
                    {cr.classification ? <Badge tone="info">{cr.classification.replace(/_/g, ' ')}</Badge> : null}
                    <span className="ml-auto text-xs text-muted">raised {clock.dateTime(cr.createdAt)}</span>
                  </span>
                  <span className="line-clamp-2 text-muted">“{cr.requested}”</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

        <Card>
          <CardHeader
            title="Recent requirement changes"
            description="Change requests raised or decided, baselines frozen and plan questions raised — newest first, across every project."
            actions={
              <a href="/api/requirements/scope-summary" className="inline-flex items-center gap-1 text-[13px] text-muted underline-offset-2 hover:underline">
                Export scope summary (CSV)
              </a>
            }
          />
          {recent.length === 0 ? (
            <EmptyState
              icon={<IconClock size={22} />}
              title="No requirement changes yet"
              description="A change request, a frozen baseline or a plan question will appear here as it happens."
              action={<Link href="/projects" className={buttonClass('secondary', 'sm')}>Open a project's scope</Link>}
            />
          ) : (
            <ul className="divide-y divide-line">
              {recent.map((r) => (
                <li key={r.id}>
                  <Link href={r.href} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px] hover:bg-surface-hover sm:px-5">
                    <Badge tone={r.kind === 'scope_frozen' ? 'success' : r.kind === 'requirement_decided' ? 'info' : r.kind === 'plan_question' ? 'warning' : 'neutral'}>
                      {r.kind === 'scope_frozen' ? 'baseline' : r.kind === 'plan_question' ? 'question' : 'change request'}
                    </Badge>
                    <span className="font-medium">{r.projectName}</span>
                    <span className="min-w-0 flex-1 truncate text-muted">{r.summary}</span>
                    {r.status ? <Badge tone="neutral">{r.status.replace(/_/g, ' ')}</Badge> : null}
                    <span className="text-xs text-muted">{clock.dateTime(r.at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {mayRaise ? (
            <RequirementsDoors projects={projectPlans} />
          ) : (
            <Card>
              <CardHeader title="Request clarification · Create change request" description="Raising a plan question or a change request takes the milestone.write permission (owner, ops admin, delivery lead)." />
            </Card>
          )}
          <Card>
            <CardHeader title="Queue Health" />
            <dl className="flex flex-col divide-y divide-line px-4 pb-3 text-[13px] sm:px-5">
              {[
                ['Drafted by hand', String(proposed.length - fromAgent), null],
                ['Waiting 3+ days', String(stale), oldest === null ? null : `oldest ${oldest} day${oldest === 1 ? '' : 's'}`],
                ['Projects with scope', `${overview.projects.filter((p) => p.scopeVersion !== null).length} of ${overview.projects.length}`, null],
                ['Awaiting client confirmation', String(dashboard.awaitingClientConfirmation), 'sent, no answer recorded'],
                ['Projects with open questions', String(openQuestionProjects), null],
                ['Scope drift alerts', String(dashboard.scopeDrift.length), 'unsettled change requests'],
              ].map(([k, v, note]) => (
                <div key={k} className="flex items-baseline justify-between gap-3 py-2">
                  <dt className="text-muted">{k}{note ? <span className="block text-xs text-faint">{note}</span> : null}</dt>
                  <dd className="tabular font-semibold text-foreground">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card>
            <CardHeader title="How a requirement moves" />
            <ol className="flex flex-col gap-3 px-4 py-3 text-[13px] sm:px-5">
              {[
                ['Conversation', 'The client says what they need on WhatsApp; the transcript is the source.'],
                ['Extraction', 'The agent (or a person) proposes a version — summary, scope items, assumptions, exclusions.'],
                ['Decision', 'An owner accepts or rejects it on the lead. Nothing downstream treats a proposal as agreed scope until then.'],
                ['Scope baseline', 'An accepted version is what the project freezes as its scope.'],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand">{i + 1}</span>
                  <span>
                    <span className="block font-medium text-foreground">{t}</span>
                    <span className="block text-muted">{d}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
          <QuickActions
            title="Quick Actions"
            actions={[
              { label: 'Leads', icon: <IconUser size={13} />, href: '/leads' },
              { label: 'Communication', icon: <IconSparkle size={13} />, href: '/communication' },
              { label: 'Projects', icon: <IconCheck size={13} />, href: '/projects' },
              { label: 'Approvals', icon: <IconClock size={13} />, href: '/approvals' },
            ]}
          />
          {proposed[0] ? (
            <Card>
              <CardHeader title="Oldest waiting" />
              <div className="px-4 pb-4 sm:px-5">
                <Link href={`/leads/${proposed[0].leadId}`} className="block text-[13px] font-medium text-foreground hover:text-brand">
                  {proposed[0].leadTitle}
                </Link>
                <p className="text-xs text-muted">
                  v{proposed[0].version} · {proposed[0].source} · proposed {clock.dateTime(proposed[0].createdAt)}
                </p>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
