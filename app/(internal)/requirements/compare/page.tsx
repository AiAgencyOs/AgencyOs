import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readQuotedRequirementVersion, readRequirementVersionsForCompare } from '@/modules/crm/requirement-compare-queries';
import { compareRequirementPayloads, quoteImpact } from '@/modules/crm/requirement-diff';
import { VersionDiff } from '@/ui/primitives/version-diff';
import { Badge, buttonClass, Card, CardHeader, EmptyState, PageHeader, PermissionDenied } from '@/ui';

export const metadata: Metadata = { title: 'Compare requirement versions' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A07 Requirement Version Compare (P1-BLUEPRINT-013): two versions of one conversation's requirement set, side by side in words: added, removed,
 * modified; who or what produced each; and what the difference means for the quotation. Both versions are historical and read-only; the current one is
 * named. Nothing here edits a requirement or a quotation.
 */
export default async function CompareRequirementVersionsPage({ searchParams }: { searchParams: Promise<{ conversation?: string; a?: string; b?: string }> }) {
  const context = await requireInternal('/requirements/compare');
  if (!can(context, 'lead.read')) return <PermissionDenied />;
  const { conversation, a, b } = await searchParams;
  const va = Number(a);
  const vb = Number(b);
  if (!conversation || !UUID.test(conversation) || !Number.isInteger(va) || !Number.isInteger(vb) || va < 1 || vb < 1 || va === vb) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Compare requirement versions" description="Choose two different versions from a lead's requirement history." />
        <EmptyState title="Nothing to compare yet" description="Open a lead's requirements and choose two versions." />
      </div>
    );
  }
  const [rows, clock] = await Promise.all([readRequirementVersionsForCompare(conversation, [va, vb]), agencyClock()]);
  const older = rows.find((r) => r.version === Math.min(va, vb));
  const newer = rows.find((r) => r.version === Math.max(va, vb));
  if (!older || !newer) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Compare requirement versions" />
        <EmptyState title="A version is not available" description="One of the two versions does not exist or is not visible to you." />
      </div>
    );
  }
  const comparison = compareRequirementPayloads(older.payload, newer.payload);
  const quoted = await readQuotedRequirementVersion([older, newer]);
  const impact = quoteImpact({ scopeChanged: comparison.scopeChanged, identical: comparison.identical, quotedVersion: quoted, fromVersion: older.version, toVersion: newer.version });
  const who = (r: typeof older) => (r.generated_by_run_id ? 'drafted by an agent run' : 'written by a person');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Requirements: version ${older.version} to version ${newer.version}`}
        description="What changed between the two versions. Both are history and cannot be edited; a correction is always the next version."
        actions={
          <Link href="/requirements" className={buttonClass('secondary', 'sm')}>
            Back to requirements
          </Link>
        }
      />
      <Card>
        <CardHeader title="Evidence" />
        <div className="grid grid-cols-1 gap-3 px-4 pb-4 text-sm sm:grid-cols-2 sm:px-5">
          {[older, newer].map((r) => (
            <div key={r.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">Version {r.version}</span>
                <Badge tone={r.status === 'accepted' ? 'success' : r.status === 'superseded' ? 'neutral' : r.status === 'rejected' ? 'danger' : 'warning'}>{r.status}</Badge>
                {r.version === newer.version ? <Badge tone="info">newer</Badge> : null}
              </div>
              <span className="text-muted">
                {who(r)} on {clock.dateTime(r.created_at)} (source: {r.source})
              </span>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader title="Impact on the quotation" />
        <p className="px-4 pb-4 text-sm sm:px-5">
          <Badge tone={impact.level === 'review' ? 'warning' : 'neutral'}>{impact.level === 'review' ? 'Needs review' : impact.level === 'none' ? 'No effect' : 'Not quoted'}</Badge> {impact.message}
        </p>
      </Card>
      <Card>
        <CardHeader title="What changed" />
        <div className="px-4 pb-4 sm:px-5">
          <VersionDiff sections={comparison.sections} fromLabel={`version ${older.version}`} toLabel={`version ${newer.version}`} />
        </div>
      </Card>
    </div>
  );
}
