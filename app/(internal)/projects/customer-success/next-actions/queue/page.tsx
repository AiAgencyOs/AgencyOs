import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readNextActions, type NextAction } from '@/modules/projects/phase-eight-g1-queries';
import { Badge, Card, CardHeader, DataTable, PageHeader, PermissionDenied, humanize, type Column, type Tone } from '@/ui';

export const metadata: Metadata = { title: 'Customer Success next actions' };

const RANK_TONE: Record<number, Tone> = { 1: 'danger', 2: 'danger', 3: 'warning', 4: 'warning', 5: 'info', 6: 'info', 7: 'neutral' };

const columns: Column<NextAction>[] = [
  { key: 'kind', header: 'Action', primary: true, cell: (a) => <Badge tone={RANK_TONE[a.rank] ?? 'neutral'}>{humanize(a.kind)}</Badge> },
  {
    key: 'client',
    header: 'Client',
    cell: (a) => (
      <span>
        <Link href={`/clients/${a.clientId}/customer-360`} className="underline">
          {a.clientName}
        </Link>
        {a.designation ? <Badge tone="info">{a.designation.toUpperCase()}</Badge> : null}
      </span>
    ),
  },
  {
    key: 'project',
    header: 'Project',
    cell: (a) =>
      a.projectId ? (
        <Link href={`/projects/${a.projectId}`} className="underline">
          {a.projectName}
        </Link>
      ) : (
        '-'
      ),
  },
  { key: 'detail', header: 'What', cell: (a) => a.detail },
  { key: 'due', header: 'Due / since', cell: (a) => (a.dueAt ? a.dueAt.slice(0, 10) : '-') },
];

/**
 * The Customer Success next-action queue (CUS-5): DERIVED from the records that exist, ordered by a fixed rank by kind, never a score. Nothing is stored; an item
 * leaves the queue when the record behind it is acknowledged, confirmed, settled or completed.
 */
export default async function CustomerSuccessNextActionsPage() {
  const context = await requireInternal('/projects/customer-success/next-actions');
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const actions = await readNextActions();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Next actions"
        description="What needs a person now, across every live Phase 8 account. Ranked by kind: escalations first, then missed SLAs, recovery and unanswered negative feedback, first responses, check-ins and renewals, requests, opportunities."
        actions={
          <Link href="/projects/customer-success" className="text-[13px] underline">
            Back to the accounts
          </Link>
        }
      />
      <Card>
        <CardHeader title={`${actions.length} item${actions.length === 1 ? '' : 's'}`} description="Showing at most 300." />
        {actions.length > 0 ? (
          <DataTable dense rows={actions} columns={columns} getKey={(a) => `${a.kind}-${a.subjectId}`} />
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing needs a person right now.</p>
        )}
      </Card>
    </div>
  );
}
