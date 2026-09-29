import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { ROLES, type Role } from '@/lib/auth/claims';
import { requireInternal } from '@/lib/auth/session';
import { can, capabilitiesFor, type Capability } from '@/lib/authz/permissions';
import { getProject, listProjectTeam, listTeamDefaults } from '@/modules/projects/queries';
import { listTeamActivity } from '@/modules/projects/team-activity-queries';
import { Badge, Card, CardHeader, EmptyState, humanize, IconClock, IconUser, PageHeader } from '@/ui';

import { ProjectSubNav } from '../project-subnav';

import { DefaultTeamPanel } from './default-team-panel';

export const metadata: Metadata = { title: 'Team' };

/** The capabilities that mean something on a project page — the rest are shown as a count. */
const DELIVERY_CAPABILITIES: readonly Capability[] = [
  'project.read',
  'project.write',
  'milestone.write',
  'task.write',
  'project.sign_off',
  'invoice.create',
  'invoice.issue',
];

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * SCR-025 — Project Team. Confirmed genuinely missing by the traceability
 * sweep: there is no `project_members` table, and `listInternalRoster`
 * elsewhere in this module is agency-wide, not per-project. Rather than
 * inventing a membership model, this reads the one fact the schema already
 * carries — who is assigned a task on this project — so the roster is
 * exactly who is doing the work, never a name added once and forgotten.
 *
 * Three additions, each labelled for what it is: the agency's DEFAULT team
 * (`group_team_defaults`, org-wide, copied onto every group card — not this
 * project's own roster), recent task activity per person, and what each
 * member's role lets them do here, read from the capability matrix rather
 * than restated.
 */
export default async function ProjectTeamPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/team`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const [team, defaults, activity, clock] = await Promise.all([
    listProjectTeam(projectId),
    listTeamDefaults(),
    listTeamActivity(projectId),
    agencyClock(),
  ]);
  const nameByUser = new Map(team.map((m) => [m.userId, m.fullName]));
  const mayEditDefaults = can(context.role, 'organization.settings');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Team`} description="Everyone with a task assigned on this project." />

      <ProjectSubNav projectId={projectId} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Working this project"
            description="A person appears here the first time a task on this project is assigned to them."
          />
          {team.length > 0 ? (
            <ul className="divide-y divide-line">
              {team.map((m) => {
                const caps = isRole(m.role) ? capabilitiesFor(m.role) : [];
                const delivery = DELIVERY_CAPABILITIES.filter((c) => caps.includes(c));
                const other = caps.length - delivery.length;
                return (
                  <li key={m.userId} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-semibold uppercase text-brand">
                          {m.fullName.slice(0, 2)}
                        </span>
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">{m.fullName}</span>
                          <span className="block truncate text-xs text-muted">{humanize(m.role)}</span>
                        </div>
                      </div>
                      <span className="shrink-0 text-xs font-medium text-muted tabular">
                        {m.tasksDone}/{m.tasksTotal} tasks done
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 pl-11">
                      <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted">May</span>
                      {delivery.length > 0 ? (
                        delivery.map((c) => (
                          <Badge key={c} tone={c.endsWith('.read') ? 'neutral' : 'brand'}>
                            {c}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-muted">nothing on a project</span>
                      )}
                      {other > 0 ? <span className="text-xs text-muted">+{other} elsewhere</span> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              icon={<IconUser size={22} />}
              title="No one assigned yet"
              description="A person shows up here the first time a task on this project is assigned to them."
            />
          )}
        </Card>

        <Card>
          <CardHeader
            title="Recent team activity"
            description="Tasks with an assignee, most recently changed first. A completed task is dated by its completion."
          />
          {activity.length > 0 ? (
            <ul className="divide-y divide-line">
              {activity.map((a) => (
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
            <EmptyState icon={<IconClock size={20} />} title="No activity yet" description="Assigned tasks show up here as they change." />
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Default team (agency-wide)"
          description="Not this project's own roster: the agency's default internal team, preselected onto every new project group card and copied when a card is raised. Adding or removing somebody here changes the default for every project's next group, and never a group that already exists."
        />
        <DefaultTeamPanel members={defaults} mayEdit={mayEditDefaults} />
        {!mayEditDefaults ? (
          <p className="border-t border-line px-4 py-2.5 text-xs text-muted sm:px-5">
            Changing the default team needs the organization settings permission.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
