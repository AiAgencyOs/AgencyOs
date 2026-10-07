import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readNextActions, type NextAction } from '@/modules/projects/phase-eight-gaps2-queries';
import { Badge, Card, CardHeader, DataTable, PageHeader, PermissionDenied, humanize, type Column, type Tone } from '@/ui';

export const metadata: Metadata = { title: 'Customer Success next actions' };

const TONE: Record<number, Tone> = { 1: 'danger', 2: 'danger', 3: 'warning', 4: 'info', 5: 'neutral' };

const columns: Column<NextAction>[] = [
  { key: 'kind', header: 'What', primary: true, cell: (a) => <Badge tone={TONE[a.priority] ?? 'neutral'}>{humanize(a.kind)}</Badge> },
  { key: 'project', header: 'Account', cell: (a) => <Link className="underline" href={`/projects/${a.projectId}`}>{a.projectName}</Link> },
  { key: 'summary', header: 'Why it is here', cell: (a) => a.summary },
  { key: 'due', header: 'Since / due', cell: (a) => (a.dueAt ? a.dueAt.slice(0, 10) : '—') },
];

/**
 * The next-action queue (Customer Success spec section 5). It is DERIVED on every read from the live records: nothing is stored, so nothing can go stale,
 * and an item leaves the list the moment the thing that put it there is done. The database orders it; this page only draws it.
 */
export default async function CustomerSuccessNextActionsPage() {
  const context = await requireInternal('/projects/customer-success/next-actions');
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const actions = await readNextActions();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Next actions"
        description="What is waiting on a person across every live account, most urgent first. Derived from the records, never stored."
        actions={<Link href="/projects/customer-success" className="text-[13px] underline">Back to the accounts</Link>}
      />
      <Card>
        <CardHeader title={`${actions.length} waiting`} description="Unacknowledged escalations, missed support targets, negative feedback, recovery plans, due check-ins, renewals and opportunities to qualify." />
        {actions.length > 0 ? (
          <DataTable dense rows={actions} columns={columns} getKey={(a) => `${a.kind}:${a.refId}`} />
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing is waiting.</p>
        )}
      </Card>
    </div>
  );
}
