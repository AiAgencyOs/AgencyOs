import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProposedRequirements } from '@/modules/crm/queries';
import { readRequirementsOverview } from '@/modules/projects/queries';
import {
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
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;
  const clock = await agencyClock();

  const [proposed, overview] = await Promise.all([listProposedRequirements(), readRequirementsOverview()]);
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

      <StatGrid cols={4}>
        <Stat label="Awaiting decision" value={String(proposed.length)} caption="Across every lead" tone={proposed.length > 0 ? 'warning' : 'success'} icon={<IconClock size={16} />} />
        <Stat label="AI extracted" value={String(fromAgent)} caption={proposed.length > 0 ? `${Math.round((fromAgent / proposed.length) * 100)}% of the queue` : 'Nothing queued'} tone="brand" icon={<IconSparkle size={16} />} />
        <Stat label="Drafted by hand" value={String(proposed.length - fromAgent)} tone="info" icon={<IconUser size={16} />} />
        <Stat label="Waiting 3+ days" value={String(stale)} caption={oldest === null ? undefined : `Oldest: ${oldest} day${oldest === 1 ? '' : 's'}`} tone={stale > 0 ? 'danger' : 'success'} icon={<IconCheck size={16} />} />
      </StatGrid>

      <StatGrid cols={4}>
        <Stat label="Frozen scopes" value={String(overview.frozenScopes)} caption="Scope versions past draft" tone="success" icon={<IconCheck size={16} />} />
        <Stat label="Open change requests" value={String(overview.openChangeRequests)} caption={`${overview.pendingApprovalChangeRequests} awaiting approval`} tone={overview.openChangeRequests > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} href="/approvals" />
        <Stat label="Open clarifications" value={String(overview.openClarifications)} caption="Plan and UI questions not resolved" tone={overview.openClarifications > 0 ? 'info' : 'neutral'} icon={<IconSparkle size={16} />} />
        <Stat label="Projects with scope" value={String(overview.projects.filter((p) => p.scopeVersion !== null).length)} caption={`of ${overview.projects.length}`} tone="brand" icon={<IconUser size={16} />} href="/projects" />
      </StatGrid>

      <Card>
        <CardHeader title="Requirement sets by project" description="The scope version each project works to, and what is open against it." />
        {overview.projects.length === 0 ? (
          <EmptyState title="No projects yet" />
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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(18rem,1fr)]">
        <Card>
          <CardHeader title="Requirement versions" description="Open the lead to read the version and accept or reject it." actions={<ViewAll href="/leads" label="All leads" />} />
          {proposed.length > 0 ? (
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={proposed} columns={columns} getKey={(r) => r.id} href={(r) => `/leads/${r.leadId}`} />
            </div>
          ) : (
            <EmptyState
              icon={<IconCheck size={22} />}
              title="Nothing awaiting a decision"
              description="A requirement version proposed by the agent or drafted by hand appears here until an owner accepts or rejects it."
            />
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
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
