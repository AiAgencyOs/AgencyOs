import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPhaseFourEscalations } from '@/modules/projects/queries';
import { DataTable, EmptyState, IconProjects, PageHeader, StatusBadge, type Column, PermissionDenied } from '@/ui';

export const metadata: Metadata = { title: 'Escalations' };

type Row = Awaited<ReturnType<typeof listPhaseFourEscalations>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  { key: 'project', header: 'Project', primary: true, cell: (r) => r.projectName },
  { key: 'state', header: 'Stopped at', badge: true, cell: (r) => <StatusBadge status={r.state} /> },
  { key: 'reason', header: 'Why', cell: (r) => r.blockedReason ?? '—' },
  {
    key: 'updated',
    header: 'Since',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (r) => clock.dateTime(r.updatedAt),
  },
];

/**
 * Master's own Admin Panel question "WHAT IS BLOCKED?" — across every
 * project's Task 2 workspace, not one at a time. `phase_four.state` reaching
 * `blocked_requirement`, `scope_escalation` or `revision_limit_escalation`
 * is real, already-stored state that had no reader beyond that one project's
 * own page — the same "found only by already knowing to look" gap
 * `20260924140000` closed for the WhatsApp announcement of the identical
 * fact. This page and that announcement now say the same thing from two
 * different angles: one tells a person the moment it happens, this shows
 * everywhere it is still true.
 *
 * Read-only, like `/agents/automations`: a workspace resumes by a human
 * decision through the actual doors (a scope change, a commercial
 * conversation, a requirement answered), never by a click on this page —
 * Master's own rule for this exact stop: "nothing resumes the loop
 * automatically."
 */
export default async function EscalationsPage() {
  const context = await requireInternal('/projects/escalations');
  const clock = await agencyClock();
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const escalations = await listPhaseFourEscalations();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Escalations"
        description={
          escalations.length === 0
            ? 'No Task 2 workspace is currently stopped for human escalation.'
            : `${escalations.length} project${escalations.length === 1 ? '' : 's'} stopped for a person to decide.`
        }
      />

      {escalations.length > 0 ? (
        <DataTable
          rows={escalations}
          columns={columnsFor(clock)}
          getKey={(r) => r.projectId}
          href={(r) => `/projects/${r.projectId}`}
        />
      ) : (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="Nothing escalated"
          description="A revision limit, a scope escalation or a blocked requirement will show up here the moment one stops a project."
        />
      )}
    </div>
  );
}
