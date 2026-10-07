import type { Metadata } from 'next';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { diffPolicyBodies, indexByKind, POLICY_KINDS, POLICY_KIND_LABEL } from '@/modules/approvals/p13-policy-model';
import { listPolicyVersions } from '@/modules/approvals/p13-policy-queries';
import { Badge, Card, CardHeader, PageHeader, PermissionDenied } from '@/ui';

import { ActivateForm, DiscardForm, DraftForm } from './policy-forms';

export const metadata: Metadata = { title: 'Policies and controls' };

/**
 * A24 Policies & Controls (P1-BLUEPRINT-030/044): the governance index. One card per policy kind: the version in force, the draft waiting (with the exact
 * settings it would change, the impact preview), and the history. Versions are written only through audited database doors an admin must call; an agent
 * has no way to reach them. A superseded version is shown, never edited.
 */
export default async function PolicyVersionsPage() {
  const context = await requireInternal('/settings/policy-versions');
  if (!can(context, 'audit.read') && !can(context, 'organization.settings')) return <PermissionDenied />;
  const mayEdit = can(context, 'organization.settings');
  const [rows, clock] = await Promise.all([listPolicyVersions(), agencyClock()]);
  const byKind = indexByKind(rows);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Policies and controls"
        description="The rules the agents work inside. Each kind has a version in force, an optional draft and a history that is never rewritten. Activating a version needs an admin and a reason."
      />
      {POLICY_KINDS.map((kind) => {
        const slot = byKind[kind];
        const changes = slot.draft ? diffPolicyBodies(slot.active?.body ?? null, slot.draft.body) : [];
        return (
          <Card key={kind}>
            <CardHeader
              title={POLICY_KIND_LABEL[kind]}
              description={slot.active ? `Version ${slot.active.version} in force since ${clock.dateTime(slot.active.activated_at ?? '')}: ${slot.active.summary}` : 'No version has been activated. Nothing is judged by this policy yet.'}
            />
            <div className="flex flex-col gap-4 px-4 pb-4 sm:px-5">
              <div className="flex flex-wrap gap-2">
                {slot.active ? <Badge tone="success">Active v{slot.active.version}</Badge> : <Badge tone="neutral">No active version</Badge>}
                {slot.draft ? <Badge tone="warning">Draft v{slot.draft.version}</Badge> : null}
              </div>

              {slot.active ? (
                <pre className="max-h-48 overflow-auto rounded bg-sunken p-3 text-xs">{JSON.stringify(slot.active.body, null, 2)}</pre>
              ) : null}

              {slot.draft ? (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">Impact preview of draft v{slot.draft.version}</h3>
                  {changes.length === 0 ? (
                    <p className="text-sm text-muted">The draft says the same as the version in force.</p>
                  ) : (
                    <ul className="text-sm">
                      {changes.map((c) => (
                        <li key={c.path} className="border-t border-line py-1">
                          <span className="font-mono text-xs">{c.path}</span>: {c.type === 'added' ? 'new' : c.type === 'removed' ? 'removed' : 'changes'}{' '}
                          {c.before !== undefined ? <span>from {JSON.stringify(c.before)} </span> : null}
                          {c.after !== undefined ? <span>to {JSON.stringify(c.after)}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  {mayEdit ? (
                    <div className="flex flex-col gap-3">
                      <ActivateForm id={slot.draft.id} />
                      <DiscardForm id={slot.draft.id} />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {mayEdit ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">{slot.draft ? 'Edit the draft' : 'Draft a new version'}</summary>
                  <div className="pt-3">
                    <DraftForm
                      kind={kind}
                      summary={slot.draft?.summary ?? ''}
                      bodyText={JSON.stringify(slot.draft?.body ?? slot.active?.body ?? {}, null, 2)}
                    />
                  </div>
                </details>
              ) : null}

              {slot.history.length > 0 ? (
                <div>
                  <h3 className="mb-1 text-sm font-semibold">History</h3>
                  <ul className="text-sm text-muted">
                    {slot.history.map((h) => (
                      <li key={h.id}>
                        v{h.version}: {h.summary} (in force from {clock.dateTime(h.activated_at ?? '')}; read-only)
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
