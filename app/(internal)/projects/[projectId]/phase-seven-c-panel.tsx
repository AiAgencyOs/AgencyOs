import type { ClientActionView, FailureItem } from '@/modules/projects/phase-seven-c-queries';
import { Badge, Card, humanize } from '@/ui';

import { SevenCForm } from './phase-seven-c-forms';

/**
 * Phase 7c (P702 §7, P703 §14, P708): what is wrong in Phase 7 right now for this project, and what the client has been asked to do.
 *
 * The Failure Queue is DERIVED: it is the current rows (a failed deployment not followed by another, a failed validation not followed by a pass, an open incident,
 * an approval nobody decided, a client action past its date), so an item leaves it when its cause is gone. A client action request is raised by a person, the
 * client resolves it with a note (a CLAIM), and a person confirms it by writing down what they checked. Nothing here sends anything to the client.
 * INTERNAL: a client sees only its own requests, on the portal page, never this panel.
 */

const KINDS: [string, string][] = [
  ['dns_change', 'DNS change'],
  ['store_account', 'Store / developer account'],
  ['account_access', 'Account access'],
  ['content_supply', 'Content to supply'],
  ['approval_input', 'Input for an approval'],
  ['other', 'Other'],
];

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2 border-t border-line pt-3">
    <span className="text-xs font-medium uppercase tracking-wide text-faint">{title}</span>
    {children}
  </section>
);

export function FailureQueueList({ items }: { items: FailureItem[] }) {
  if (items.length === 0) return <p className="text-xs text-muted">Nothing is failing, stuck or overdue in Phase 7 right now.</p>;
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted">
      {items.map((f) => (
        <li key={`${f.kind}:${f.subjectId}`} className="flex flex-wrap items-center gap-2">
          <Badge tone={f.kind === 'incident_open' || f.kind === 'deployment_failed' ? 'danger' : 'warning'}>{humanize(f.kind)}</Badge>
          <span className="font-medium text-foreground">{f.projectName}</span>
          <span>{f.detail}</span>
          <span>
            since {f.since} ({f.ageHours} h)
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PhaseSevenCPanel({ projectId, failures, actions }: { projectId: string; failures: FailureItem[]; actions: ClientActionView[] }) {
  const waiting = actions.filter((a) => a.status === 'submitted');
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Phase 7c: failure queue and client actions</span>
        <Badge tone={failures.length > 0 ? 'danger' : 'neutral'}>{failures.length > 0 ? `${failures.length} item(s) need attention` : 'Nothing failing'}</Badge>
      </div>

      <Section title="Failure queue (derived from the current rows)">
        <FailureQueueList items={failures} />
      </Section>

      <Section title={`Client actions${waiting.length > 0 ? ` (${waiting.length} waiting for you to confirm)` : ''}`}>
        {actions.length === 0 ? (
          <p className="text-xs text-muted">The client has been asked to do nothing.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-xs text-muted">
            {actions.map((a) => (
              <li key={a.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={a.status === 'confirmed' ? 'success' : a.overdue ? 'danger' : a.status === 'submitted' ? 'warning' : 'neutral'}>{a.overdue ? 'Overdue' : humanize(a.status)}</Badge>
                  <span className="font-medium text-foreground">{a.title}</span>
                  <span>
                    {humanize(a.kind)} · due {a.dueAt}
                  </span>
                </div>
                {a.status === 'submitted' ? (
                  <div className="flex flex-col gap-1">
                    <span>
                      {a.submittedName ?? 'The client'} says it is done ({a.submittedAt}): &quot;{a.submissionNote}&quot;{a.submissionRef ? ` · ${a.submissionRef}` : ''}
                    </span>
                    <details>
                      <summary className="cursor-pointer underline underline-offset-2">Confirm or send back</summary>
                      <div className="flex flex-col gap-2">
                        <SevenCForm door="settle_client_action" projectId={projectId} hidden={{ requestId: a.id, decision: 'confirmed' }} submit="Confirm" intro="The client's word is not the evidence. Check it yourself and write down what you checked." fields={[{ kind: 'textarea', name: 'note', label: 'What you checked', required: true }]} />
                        <SevenCForm door="settle_client_action" projectId={projectId} hidden={{ requestId: a.id, decision: 'rejected' }} submit="Send back to the client" fields={[{ kind: 'textarea', name: 'note', label: 'What is still missing (the client sees this)', required: true }]} />
                      </div>
                    </details>
                  </div>
                ) : null}
                {a.status === 'open' && a.returnedNote ? <span>Sent back: &quot;{a.returnedNote}&quot;</span> : null}
                {a.status === 'open' || a.status === 'submitted' ? (
                  <details>
                    <summary className="cursor-pointer underline underline-offset-2">Cancel this request</summary>
                    <SevenCForm door="settle_client_action" projectId={projectId} hidden={{ requestId: a.id, decision: 'cancelled' }} submit="Cancel" fields={[{ kind: 'textarea', name: 'note', label: 'Why (required)', required: true }]} />
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <SevenCForm
          door="raise_client_action"
          projectId={projectId}
          submit="Ask the client"
          intro="The client sees this in the portal with its deadline. Nothing is sent to them: tell them yourself."
          fields={[
            { kind: 'select', name: 'kind', label: 'What kind of thing', options: KINDS },
            { kind: 'text', name: 'title', label: 'Short title', required: true },
            { kind: 'textarea', name: 'instructions', label: 'The exact instruction (no passwords or keys)', required: true },
            { kind: 'datetime-local', name: 'dueAt', label: 'Deadline', required: true },
          ]}
        />
      </Section>
    </Card>
  );
}
