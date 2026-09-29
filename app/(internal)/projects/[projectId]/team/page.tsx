import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listInternalRoster, listProjectTeam } from '@/modules/projects/queries';

import { DeliveryLeadForm } from '../milestone-controls';
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  DataTable,
  DonutChart,
  EmptyState,
  humanize,
  IconCheck,
  IconUser,
  IconUsers,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  type Column,
} from '@/ui';

import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

export const metadata: Metadata = { title: 'Team' };

/**
 * SCR-025 — Project Team, laid out as the reference: a figure per role, the
 * roster table with role chips and progress, and the role distribution
 * beside it. There is no `project_members` table, and `listInternalRoster`
 * elsewhere in this module is agency-wide, not per-project; rather than
 * inventing a membership model this reads the one fact the schema already
 * carries — who is assigned a task on this project — so the roster is
 * exactly who is doing the work. No "online" state or invite form is
 * drawn: neither presence nor per-project invitations exist in the data
 * model, and a control that pretends to would be the fake-success failure
 * the brief forbids. People join a project by being assigned a task.
 */
export default async function ProjectTeamPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/team`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [team, roster, clock, clientName] = await Promise.all([
    listProjectTeam(projectId),
    listInternalRoster(),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);

  const canEdit = can(context.role, 'project.write');
  const lead = project.delivery_lead_id ? (roster.find((m) => m.userId === project.delivery_lead_id) ?? null) : null;
  const byRole = new Map<string, number>();
  for (const m of team) byRole.set(m.role, (byRole.get(m.role) ?? 0) + 1);
  const roles = [...byRole.entries()].sort((a, b) => b[1] - a[1]);
  const tasksTotal = team.reduce((n, m) => n + m.tasksTotal, 0);
  const tasksDone = team.reduce((n, m) => n + m.tasksDone, 0);

  type Member = (typeof team)[number];
  const columns: Column<Member>[] = [
    {
      key: 'name',
      header: 'Name',
      primary: true,
      cell: (m) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={m.fullName} size="md" />
          <span className="min-w-0">
            <span className="block truncate">{m.fullName}</span>
            <span className="block truncate text-xs font-normal text-muted">{m.email}</span>
          </span>
        </span>
      ),
    },
    { key: 'role', header: 'Role', badge: true, cell: (m) => <Badge tone="info">{humanize(m.role)}</Badge> },
    {
      key: 'progress',
      header: 'Tasks done',
      width: '12rem',
      cell: (m) => <ProgressBar value={m.tasksTotal > 0 ? (m.tasksDone / m.tasksTotal) * 100 : 0} label={`${m.fullName} tasks done`} />,
    },
    { key: 'count', header: 'Assigned', align: 'right', cellClassName: 'tabular text-muted', cell: (m) => `${m.tasksDone}/${m.tasksTotal}` },
  ];

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={can(context.role, 'project.write')} />

      <ProjectSubNav projectId={projectId} />

      {team.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Total members" value={String(team.length)} caption="Everyone with a task" tone="brand" icon={<IconUsers size={16} />} />
          {roles.slice(0, 3).map(([role, n]) => (
            <Stat key={role} label={humanize(role)} value={String(n)} caption={`${Math.round((n / team.length) * 100)}% of the team`} tone="info" icon={<IconUser size={16} />} />
          ))}
          <Stat label="Tasks done" value={`${tasksDone}/${tasksTotal}`} caption={tasksTotal > 0 ? `${Math.round((tasksDone / tasksTotal) * 100)}% complete` : undefined} tone="success" icon={<IconCheck size={16} />} />
        </StatGrid>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(18rem,1fr)]">
        <Card>
          <CardHeader title="Team members" description="Everyone with a task assigned on this project. A person joins by being assigned work on the Board." />
          {team.length > 0 ? (
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={team} columns={columns} getKey={(m) => m.userId} />
            </div>
          ) : (
            <EmptyState icon={<IconUser size={22} />} title="No one assigned yet" description="A person shows up here the first time a task on this project is assigned to them." />
          )}
        </Card>

        <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Delivery lead" description="Who answers for this project's delivery. Set from the agency roster; nothing else changes." />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            {lead ? (
              <div className="flex items-center gap-2.5">
                <Avatar name={lead.fullName} size="md" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{lead.fullName}</span>
                  <span className="block truncate text-xs text-muted">{lead.email} · {humanize(lead.role)}</span>
                </span>
              </div>
            ) : (
              <p className="text-[13px] text-muted">{project.delivery_lead_id ? 'Assigned to someone no longer on the roster.' : 'Nobody has been named yet.'}</p>
            )}
            {canEdit ? <DeliveryLeadForm projectId={projectId} current={project.delivery_lead_id} roster={roster} /> : null}
          </div>
        </Card>
        <Card>
          <CardHeader title="Team role distribution" />
          <div className="p-4 sm:p-5">
            {roles.length === 0 ? (
              <p className="text-[13px] text-muted">Nothing to distribute yet.</p>
            ) : (
              <DonutChart data={roles.map(([role, n]) => ({ label: humanize(role), value: n }))} totalLabel="Members" height={150} />
            )}
          </div>
        </Card>
        </div>
      </div>
    </div>
  );
}
