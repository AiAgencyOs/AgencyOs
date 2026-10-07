import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readAccessDenials, readRetentionStatus, type AccessDenial, type RetentionRow } from '@/modules/projects/phase-eight-g1-queries';
import { Badge, Card, CardHeader, DataTable, PageHeader, PermissionDenied, humanize, type Column } from '@/ui';

export const metadata: Metadata = { title: 'Phase 8 governance' };

const denialColumns: Column<AccessDenial>[] = [
  { key: 'at', header: 'When', primary: true, cell: (d) => d.createdAt.slice(0, 16).replace('T', ' ') },
  { key: 'who', header: 'Who', cell: (d) => humanize(d.actorKind) },
  { key: 'surface', header: 'Asked for', cell: (d) => humanize(d.surface) },
  { key: 'subject', header: 'Record', cell: (d) => d.subjectId ?? '-' },
  { key: 'reason', header: 'Why refused', cell: (d) => humanize(d.reason) },
];

function policyCell(r: RetentionRow) {
  if (!r.recordClass) return '-';
  if (!r.policySet) return <Badge tone="warning">Not set</Badge>;
  return r.indefinite ? `v${r.policyVersion}: indefinite` : `v${r.policyVersion}: ${r.retentionDays} days`;
}

const retentionColumns: Column<RetentionRow>[] = [
  { key: 'set', header: 'Data set', primary: true, cell: (r) => humanize(r.dataSet) },
  { key: 'class', header: 'Retention class', cell: (r) => (r.recordClass ? humanize(r.recordClass) : <Badge tone="warning">No class covers this</Badge>) },
  { key: 'policy', header: 'Admin policy', cell: policyCell },
  { key: 'rows', header: 'Rows held', align: 'right', cell: (r) => r.rowsHeld },
  { key: 'oldest', header: 'Oldest', cell: (r) => (r.oldestAt ? r.oldestAt.slice(0, 10) : '-') },
];

/**
 * Phase 8 governance: refused reads (E2E-13) and the retention state of every Phase 8 data set (P8-SEC-006). Reads only. Nothing here deletes or disposes of a
 * record: disposal is a decision a person makes, and where no record class covers a data set the page says so rather than pretending one does.
 */
export default async function PhaseEightGovernancePage() {
  const context = await requireInternal('/projects/customer-success/governance');
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const [denials, retention] = await Promise.all([readAccessDenials(), readRetentionStatus()]);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Phase 8 governance"
        description="Refused reads and retention. Nothing on this page deletes anything."
        actions={
          <Link href="/projects/customer-success" className="text-[13px] underline">
            Back to the accounts
          </Link>
        }
      />
      <Card>
        <CardHeader title="Retention" description="The Admin-set policy that covers each data set, if any." />
        <DataTable dense rows={retention} columns={retentionColumns} getKey={(r) => r.dataSet} />
      </Card>
      <Card>
        <CardHeader title="Refused reads" description="Someone asked for a Phase 8 record their organization or portal does not own. Admins only; the log never says whether the record exists elsewhere." />
        {denials.length > 0 ? (
          <DataTable dense rows={denials} columns={denialColumns} getKey={(d) => d.id} />
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No refused reads recorded (or you are not an Admin).</p>
        )}
      </Card>
    </div>
  );
}
