import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listIncidents } from '@/modules/identity/incidents-queries';
import { Badge, Card, CardHeader, EmptyState, IconSecurity, PageHeader, PermissionDenied, Stat, StatGrid } from '@/ui';

import { TrailLabel } from '../../trail-label';
import { OpenIncidentForm, ResolveIncidentForm } from './incident-forms';

export const metadata: Metadata = { title: 'Security incidents' };

const SEVERITY_TONE = { low: 'neutral', medium: 'info', high: 'warning', critical: 'danger' } as const;

/**
 * Incident and security-exception history — SCR-069. What a person opened
 * (`security.incidents`), with its evidence, and how it was resolved. The
 * audit trail's "Investigate" link lands here with the entry prefilled as
 * evidence (`?audit=<id>`), so an event becomes an incident without
 * retyping what was seen. Gated on `audit.read` like the pages around it.
 */
export default async function SecurityIncidentsPage({ searchParams }: { searchParams: Promise<{ audit?: string; evidence?: string }> }) {
  const context = await requireInternal('/security/incidents');
  if (!can(context, 'audit.read')) return <PermissionDenied />;
  const clock = await agencyClock();

  const { audit, evidence } = await searchParams;
  const auditEntryId = audit && /^[0-9]+$/.test(audit) ? Number(audit) : undefined;
  const incidents = await listIncidents();
  const open = incidents.filter((i) => i.resolvedAt === null);
  const resolved = incidents.filter((i) => i.resolvedAt !== null);
  const critical = open.filter((i) => i.severity === 'critical').length;

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name="Incidents" />
      <PageHeader
        eyebrow="Security"
        title="Security incidents"
        description="What a person opened, the evidence it started from, and how it was resolved. Every open and resolve is audited."
        meta={
          <Badge tone={critical > 0 ? 'danger' : open.length > 0 ? 'warning' : 'success'} dot>
            {critical > 0 ? `${critical} critical open` : open.length > 0 ? `${open.length} open` : 'Nothing open'}
          </Badge>
        }
        actions={
          <Link href="/audit" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
            Audit trail
          </Link>
        }
      />

      <StatGrid>
        <Stat label="Open" value={String(open.length)} caption="Awaiting resolution" tone={open.length > 0 ? 'warning' : 'neutral'} icon={<IconSecurity size={16} />} />
        <Stat label="Critical open" value={String(critical)} caption="Severity critical, unresolved" tone={critical > 0 ? 'danger' : 'neutral'} icon={<IconSecurity size={16} />} />
        <Stat label="Resolved" value={String(resolved.length)} caption="Most recent 200 in all" tone="success" icon={<IconSecurity size={16} />} />
        <Stat label="From the audit trail" value={String(incidents.filter((i) => i.evidence.opened_from === 'audit').length)} caption="Opened by investigating an event" tone="info" icon={<IconSecurity size={16} />} />
      </StatGrid>

      <Card>
        <CardHeader
          title={auditEntryId ? `Open an incident from audit entry #${auditEntryId}` : 'Open an incident'}
          description="Say what happened, how bad it is, and what was seen. Owner or ops admin."
        />
        <OpenIncidentForm auditEntryId={auditEntryId} evidence={evidence ?? (auditEntryId ? `Audit entry #${auditEntryId}` : undefined)} />
      </Card>

      <Card>
        <CardHeader title="Open incidents" description={open.length === 0 ? 'Nothing is open.' : `${open.length} awaiting resolution, newest first.`} />
        {open.length === 0 ? (
          <div className="px-4 pb-4 sm:px-5">
            <EmptyState icon={<IconSecurity size={20} />} title="No open incident" description="An event worth investigating becomes an incident from the audit trail or the form above." />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {open.map((i) => (
              <li key={i.id} className="flex flex-col gap-1.5 px-4 py-3 text-[13px] sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY_TONE[i.severity]} dot>
                      {i.severity}
                    </Badge>
                    <Badge tone="neutral">{i.kind.replace(/_/g, ' ')}</Badge>
                    <span className="font-medium">{i.summary}</span>
                  </span>
                  <span className="text-xs text-muted">
                    opened {clock.dateTime(i.openedAt)} by {i.openedByName ?? 'unknown'}
                  </span>
                </div>
                {typeof i.evidence.notes === 'string' && i.evidence.notes ? <p className="break-words text-xs text-muted">Evidence: {i.evidence.notes}</p> : null}
                {typeof i.evidence.audit_entry_id === 'number' ? (
                  <Link href={`/audit`} className="text-xs text-brand underline-offset-2 hover:underline">
                    audit entry #{i.evidence.audit_entry_id}
                  </Link>
                ) : null}
                <ResolveIncidentForm incidentId={i.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Resolved" description={resolved.length === 0 ? 'Nothing has been resolved yet.' : 'The history, newest first.'} />
        {resolved.length > 0 ? (
          <ul className="divide-y divide-line">
            {resolved.map((i) => (
              <li key={i.id} className="flex flex-col gap-1 px-4 py-3 text-[13px] sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
                    <Badge tone="neutral">{i.kind.replace(/_/g, ' ')}</Badge>
                    <span>{i.summary}</span>
                  </span>
                  <span className="text-xs text-muted">
                    resolved {i.resolvedAt ? clock.dateTime(i.resolvedAt) : ''} by {i.resolvedByName ?? 'unknown'}
                  </span>
                </div>
                <p className="break-words text-xs text-muted">“{i.resolution}”</p>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}
