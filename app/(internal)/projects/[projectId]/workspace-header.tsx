import Link from 'next/link';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import type { ProjectDetail } from '@/modules/projects/types';
import { buttonClass, EntityHeader, IconCalendar, IconEdit, IconList, IconUser, StatusBadge } from '@/ui';

import { TrailLabel } from '../../trail-label';

/**
 * The project's identity strip every workspace tab carries above the tab
 * row — the reference's Board/Tasks/Files screens all repeat the header the
 * overview has, in a shorter form. Facts come from the row the page already
 * read; nothing here queries.
 */
export function WorkspaceHeader({
  project,
  clock,
  clientName,
  canEdit,
  actions,
}: {
  project: ProjectDetail;
  clock: AgencyClock;
  clientName: string | null;
  canEdit: boolean;
  actions?: React.ReactNode;
}) {
  const daysLeft = project.ends_on
    ? Math.ceil((new Date(`${project.ends_on}T00:00:00Z`).getTime() - Date.now()) / 86_400_000)
    : null;
  return (
    <>
      <TrailLabel name={project.name} />
      <EntityHeader
        name={project.name}
        status={<StatusBadge status={project.status} />}
        subtitle={project.description ?? undefined}
        facts={[
          { label: 'Client', value: clientName ?? 'Internal project', icon: <IconUser size={14} /> },
          { label: 'Project code', value: <span className="font-mono">{project.code}</span>, icon: <IconList size={14} /> },
          { label: 'Start date', value: project.starts_on ? clock.date(project.starts_on) : 'Not set', icon: <IconCalendar size={14} /> },
          {
            label: daysLeft === null ? 'Due date' : daysLeft >= 0 ? `${daysLeft} days remaining` : `${-daysLeft} days overdue`,
            value: project.ends_on ? clock.date(project.ends_on) : 'Not set',
            icon: <IconCalendar size={14} />,
          },
        ]}
        actions={
          <>
            {actions}
            {canEdit ? (
              <Link href={`/projects/${project.id}/settings`} className={buttonClass('primary', 'sm')}>
                <IconEdit size={14} />
                Edit project
              </Link>
            ) : null}
          </>
        }
      />
    </>
  );
}
