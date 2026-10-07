import type { PhaseSevenBView } from '@/modules/projects/phase-seven-b-queries';
import { Badge, Card, humanize } from '@/ui';

import { SevenBForm } from './phase-seven-b-forms';

/**
 * Phase 7b (P703, P707, P708, P711): the client's portal requests, who opened the handover, the archive and the Admin-set retention policy, and the
 * Orchestrator's recorded Phase 7 routing. It renders STORED state; every form calls a database door.
 *
 * HONESTY: a portal request is NOT an acceptance. Confirming one needs your own verification that it came from the client, and it records the formal acceptance
 * of the exact version. Nothing on this page deletes anything: archiving freezes scope records, and the retention sweep only marks records eligible for review.
 * INTERNAL: a client sees none of this (the tables are internal-only by policy).
 */

const CLASSES = ['contractual_documents', 'financial_records', 'source_build_references', 'approvals_audit', 'support_warranty_records', 'handover_packages', 'completion_records', 'client_portal_access'];

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2 border-t border-line pt-3">
    <span className="text-xs font-medium uppercase tracking-wide text-faint">{title}</span>
    {children}
  </section>
);

export function PhaseSevenBPanel({ view, projectId }: { view: PhaseSevenBView; projectId: string }) {
  const { requests, accessLog, archive, policies, reviews, routing } = view;
  const open = requests.filter((r) => !r.settlement);
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Phase 7b: client portal, archive and routing</span>
        <Badge tone={open.length > 0 ? 'warning' : 'neutral'}>{open.length > 0 ? `${open.length} portal request(s) waiting` : 'No portal request waiting'}</Badge>
      </div>

      <Section title="Portal requests (a request is not an acceptance)">
        {requests.length === 0 ? (
          <p className="text-xs text-muted">The client has asked for nothing in the portal.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-xs text-muted">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.settlement ? (r.settlement.decision === 'confirmed' ? 'success' : 'neutral') : 'warning'}>{r.settlement ? humanize(r.settlement.decision) : 'Waiting for a person'}</Badge>
                  <span className="font-medium text-foreground">{humanize(r.kind)}</span>
                  <span>
                    version {r.version} · {r.requestedName} · {r.requestedAt}
                  </span>
                  {r.note ? <span>&quot;{r.note}&quot;</span> : null}
                  {r.settlement?.note ? <span>({r.settlement.note})</span> : null}
                </div>
                {!r.settlement ? (
                  <details>
                    <summary className="cursor-pointer underline underline-offset-2">Confirm or decline</summary>
                    <div className="flex flex-col gap-2">
                      <SevenBForm door="settle_request" projectId={projectId} hidden={{ requestId: r.id, decision: 'confirmed' }} submit="Confirm (record the formal acceptance)" intro="Verify with the client first (a call, an email, the signed document) and write down how. That becomes the evidence for the exact version." fields={[{ kind: 'textarea', name: 'verification', label: 'How you verified it was the client', required: true }, { kind: 'text', name: 'note', label: 'Note (optional)' }]} />
                      <SevenBForm door="settle_request" projectId={projectId} hidden={{ requestId: r.id, decision: 'declined' }} submit="Decline" fields={[{ kind: 'textarea', name: 'note', label: 'Why (required)', required: true }]} />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Who opened the delivered handover (latest 20)">
        {accessLog.length === 0 ? (
          <p className="text-xs text-muted">Nothing has been opened.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {accessLog.map((a, i) => (
              <li key={`${i}-${a.at}`}>
                {humanize(a.event)}
                {a.itemKind ? `: ${humanize(a.itemKind)}` : ''} · version {a.version} · {a.at}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Retention policy (set by an Admin; the system holds no default)">
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {CLASSES.map((c) => {
            const p = policies.find((x) => x.recordClass === c);
            return (
              <li key={c} className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{humanize(c)}</span>
                {p ? (
                  <>
                    <Badge tone="info">v{p.version}</Badge>
                    <span>{p.indefinite ? 'indefinite' : `${p.days} days`}</span>
                    {p.portalReadOnly !== null ? <span>{p.portalReadOnly ? 'portal read-only' : 'portal stays writable'}</span> : null}
                    <span>({p.reason})</span>
                  </>
                ) : (
                  <Badge tone="danger">Not decided</Badge>
                )}
              </li>
            );
          })}
        </ul>
        <details>
          <summary className="cursor-pointer underline underline-offset-2">Set or change a policy (a new version)</summary>
          <SevenBForm door="set_policy" projectId={projectId} submit="Save policy" intro="A period in days, or indefinite. For the portal class, whether it becomes read-only on archive and how long it stays open."
            fields={[{ kind: 'select', name: 'recordClass', label: 'Record class', options: CLASSES.map((c) => [c, humanize(c)]) }, { kind: 'yesno', name: 'indefinite', label: 'Retained indefinitely' }, { kind: 'number', name: 'days', label: 'Days (if not indefinite)' }, { kind: 'yesno', name: 'portalReadOnly', label: 'Portal becomes read-only (portal class only)' }, { kind: 'textarea', name: 'reason', label: 'Why', required: true }]} />
        </details>
      </Section>

      <Section title="Archive (not deletion)">
        {archive ? (
          <div className="flex flex-col gap-2 text-xs text-muted">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={archive.state === 'archived' ? 'success' : 'warning'}>{humanize(archive.state)}</Badge>
              <span>started {archive.startedAt}</span>
              {archive.archivedAt ? <span>archived {archive.archivedAt}</span> : null}
              <span>portal {archive.portalReadOnly ? 'read-only' : 'writable'}</span>
            </div>
            {archive.state === 'archiving' ? <SevenBForm door="finish_archive" projectId={projectId} submit="Finish archiving" intro="Marks the archive ARCHIVED. Scope records stay frozen; nothing is deleted." /> : null}
          </div>
        ) : (
          <SevenBForm door="start_archive" projectId={projectId} submit="Start archiving" intro="Only a completed project, and only once a retention policy exists for every class. Freezes the project's tasks, modules, features and deliverables; deletes nothing." />
        )}
        {reviews.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {reviews.map((r, i) => (
              <li key={`${i}-${r.recordClass}-${r.policyVersion}`}>
                <Badge tone="warning">Eligible for review</Badge> {humanize(r.recordClass)} (policy v{r.policyVersion}) since {r.eligibleAt}. Nothing has been deleted.
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Orchestrator routing decisions (Phase 7)">
        {routing.length === 0 ? (
          <p className="text-xs text-muted">No Phase 7 task has been routed yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {routing.map((d, i) => (
              <li key={`${i}-${d.decidedAt}`} className="flex flex-wrap items-center gap-2">
                <Badge tone={d.outcome === 'routed' ? 'success' : d.outcome === 'refused' ? 'danger' : 'warning'}>{humanize(d.outcome)}</Badge>
                <span className="font-medium text-foreground">{humanize(d.taskType)}</span>
                <span>{d.toAgent ? `${d.toAgent}: ` : ''}{d.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Card>
  );
}
