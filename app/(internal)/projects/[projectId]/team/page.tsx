import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { ROLES, type Role } from '@/lib/auth/claims';
import { capabilitiesFor, type Capability } from '@/lib/authz/permissions';
import { getProject, listInternalRoster, listProjectTeam, listTeamDefaults } from '@/modules/projects/queries';
import { listProjectMembers, readLastActive } from '@/modules/projects/project-members-queries';
import { listTeamActivity } from '@/modules/projects/team-activity-queries';

import { ProjectMembersPanel } from './members-panel';

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
  IconPlus,
  IconSearch,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  type Column,
} from '@/ui';

import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

import { DefaultTeamPanel } from './default-team-panel';

/** The capabilities that mean something on a project page — the rest are shown as a count. */
const DELIVERY_CAPABILITIES: readonly Capability[] = ['project.read', 'project.write', 'milestone.write', 'task.write', 'project.sign_off', 'invoice.create', 'invoice.issue'];

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

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
export default async function ProjectTeamPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ q?: string }> }) {
  const { projectId } = await params;
  const { q } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/team`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [team, roster, clock, clientName, defaults, activity, members] = await Promise.all([
    listProjectTeam(projectId),
    listInternalRoster(),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    listTeamDefaults(),
    listTeamActivity(projectId),
    // SCR-025 (20261001120000): the project's own roster, with project roles.
    listProjectMembers(projectId),
  ]);
  // SCR-025 "Active now" — as the schema can honestly state it: last active,
  // from the newest audit row each person wrote. Readable by audit.read roles.
  const canReadAudit = can(context, 'audit.read');
  const lastActive = await readLastActive([...new Set([...team.map((m) => m.userId), ...members.map((m) => m.userId)])], canReadAudit);
  const lastActiveLabels: Record<string, string> = {};
  if (lastActive.visible) for (const [userId, at] of Object.entries(lastActive.byUser)) lastActiveLabels[userId] = clock.dateTime(at);
  const activeToday = lastActive.visible ? Object.values(lastActive.byUser).filter((at) => clock.dayKey(at) === clock.dayKey(new Date())).length : null;
  const mayEditDefaults = can(context, 'organization.settings');
  const nameByUser = new Map(roster.map((m) => [m.userId, m.fullName]));

  const canEdit = can(context, 'project.write');
  const lead = project.delivery_lead_id ? (roster.find((m) => m.userId === project.delivery_lead_id) ?? null) : null;
  const byRole = new Map<string, number>();
  for (const m of team) byRole.set(m.role, (byRole.get(m.role) ?? 0) + 1);
  const roles = [...byRole.entries()].sort((a, b) => b[1] - a[1]);
  const tasksTotal = team.reduce((n, m) => n + m.tasksTotal, 0);
  const tasksDone = team.reduce((n, m) => n + m.tasksDone, 0);

  const needle = q?.trim().toLowerCase() ?? '';
  const shownTeam = needle ? team.filter((m) => m.fullName.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle)) : team;
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
    // SCR-025 "Active now": last active, from the audit log — never an invented "online".
    { key: 'active', header: 'Last active', desktopOnly: true, cellClassName: 'text-muted whitespace-nowrap', cell: (m) => (lastActive.visible ? (lastActiveLabels[m.userId] ?? 'no recorded activity') : '—') },
    {
      // SCR-025: what the role lets this person do here, read from the
      // capability matrix rather than restated.
      key: 'may',
      header: 'Permissions',
      desktopOnly: true,
      cell: (m) => {
        const caps = isRole(m.role) ? capabilitiesFor(m.role) : [];
        const delivery = DELIVERY_CAPABILITIES.filter((c) => caps.includes(c) && !c.endsWith('.read')).slice(0, 2);
        const other = DELIVERY_CAPABILITIES.filter((c) => caps.includes(c) && !c.endsWith('.read')).length - delivery.length;
        return (
          <span className="flex flex-wrap items-center gap-1">
            {delivery.length > 0 ? delivery.map((c) => <Badge key={c} tone={c.endsWith('.read') ? 'neutral' : 'brand'}>{c}</Badge>) : <span className="text-xs text-muted">nothing on a project</span>}
            {other > 0 ? <span className="text-xs text-muted">+{other} more</span> : null}
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={can(context, 'project.write')} />

      <ProjectSubNav projectId={projectId} />

      <section aria-labelledby="team-title" className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="team-title" className="text-xl font-bold tracking-tight text-foreground">Project Team</h2>
          <p className="text-[13px] text-muted">Manage team members, roles, permissions and collaboration</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form action={`/projects/${projectId}/team`} method="GET" className="relative">
            <label>
              <span className="sr-only">Search team members</span>
              <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><IconSearch size={15} /></span>
              <input type="search" name="q" defaultValue={q ?? ''} placeholder="Search team members..." className="h-10 w-64 rounded-lg border border-line bg-surface pl-9 pr-3 text-[13px] text-foreground placeholder:text-faint" />
            </label>
          </form>
          {canEdit ? (
            <a href="#invite-member" className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-[13px] font-semibold text-brand-fg shadow-xs hover:opacity-90">
              <IconPlus size={15} />
              Invite Member
            </a>
          ) : null}
        </div>
      </section>

      {team.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Total members" value={String(team.length)} caption="Everyone with a task" tone="brand" icon={<IconUsers size={16} />} />
          {roles.slice(0, 3).map(([role, n]) => (
            <Stat key={role} label={humanize(role)} value={String(n)} caption={`${Math.round((n / team.length) * 100)}% of the team`} tone="info" icon={<IconUser size={16} />} />
          ))}
          <Stat label="Tasks done" value={`${tasksDone}/${tasksTotal}`} caption={tasksTotal > 0 ? `${Math.round((tasksDone / tasksTotal) * 100)}% complete` : undefined} tone="success" icon={<IconCheck size={16} />} />
          {/* SCR-025 "Active now" — last active today, from the audit log; a role that cannot read it is told so. */}
          <Stat label="Active today" value={activeToday === null ? '—' : String(activeToday)} caption={activeToday === null ? 'Audit log not visible to your role' : 'wrote an audit row today'} tone={activeToday ? 'success' : 'neutral'} icon={<IconUser size={16} />} />
        </StatGrid>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader title="Team Members" description="Everyone with a task assigned on this project, whether or not they are on the roster above. A person joins by being assigned work on the Board." />
          {team.length > 0 ? (
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={shownTeam} columns={columns} getKey={(m) => m.userId} />
            </div>
          ) : (
            <EmptyState icon={<IconUser size={22} />} title="No one assigned yet" description="A person shows up here the first time a task on this project is assigned to them." />
          )}
        </Card>
        {/* SCR-025 (20261001120000): the project's own roster — assign, set a project role, remove. */}
        <Card id="invite-member">
          <CardHeader
            title={`Project Members (${members.length})`}
            description="Add team members to collaborate on this project. The Board offers them first when assigning a task."
          />
          <ProjectMembersPanel projectId={projectId} members={members} roster={roster} lastActive={lastActive} lastActiveLabels={lastActiveLabels} mayEdit={canEdit} />
        </Card>
        </div>

        <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Team Role Distribution" />
          <div className="p-4 sm:p-5">
            {roles.length === 0 ? (
              <p className="text-[13px] text-muted">Nothing to distribute yet.</p>
            ) : (
              <DonutChart data={roles.map(([role, n]) => ({ label: humanize(role), value: n }))} totalLabel="Members" height={150} />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent Team Activity" description="Assigned tasks, most recently changed first. A completed task is dated by its completion." />
          {activity.length > 0 ? (
            <ul className="divide-y divide-line">
              {activity.slice(0, 10).map((a) => (
                <li key={a.taskId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{a.title}</span>
                    <span className="block text-xs text-muted">
                      {nameByUser.get(a.assigneeId) ?? 'Unknown member'} · {a.kind === 'completed' ? 'completed' : `updated · ${humanize(a.status)}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{clock.dateTime(a.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Assigned tasks show up here as they change.</p>
          )}
        </Card>
        <Card>
          <CardHeader title="Delivery Lead" description="Who answers for this project's delivery. Set from the agency roster; nothing else changes." />
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
        </div>
      </div>

      <Card>
        <CardHeader
          title="Default team (agency-wide)"
          description="Not this project's own roster: the agency's default internal team, preselected onto every new project group card and copied when a card is raised. Adding or removing somebody here changes the default for every project's next group, and never a group that already exists."
        />
        <DefaultTeamPanel members={defaults} mayEdit={mayEditDefaults} />
        {!mayEditDefaults ? (
          <p className="border-t border-line px-4 py-2.5 text-xs text-muted sm:px-5">Changing the default team needs the organization settings permission.</p>
        ) : null}
      </Card>
    </div>
  );
}
