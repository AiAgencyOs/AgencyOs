import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { listIntegrations } from '@/modules/acquisition/queries';
import { PROVIDER_CATALOG, VERIFICATION_WORDS, type Provider, type Verification } from '@/modules/acquisition/providers';
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied } from '@/ui';

import { AddConnectionForm, IntegrationStateForm, StoreSecretForm, TestConnectionButton } from './forms';

export const metadata: Metadata = { title: 'Lead generation connections' };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN') : 'never');

/**
 * Every outside account an engine will use. The page is deliberately blunt about what has been PROVEN: "Not built" means
 * AgencyOS has no adapter for that provider, so no key can make it work; "Verified" appears only after a real check against
 * the live account passed. A stored credential alone never changes either word.
 */
export default async function ConnectionsPage() {
  const context = await requireInternal('/lead-generation/connections');
  if (!can(context, 'acquisition.read')) return <PermissionDenied />;
  const mayManage = can(context, 'acquisition.manage');
  const isOwner = hasRole(context, 'owner');
  const integrations = await listIntegrations();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Lead generation" title="Connections" description="The ad, social, email, deployment and marketplace accounts the engines will use. Credentials are entered here, encrypted, and never shown again." />

      <Callout tone="info" title="What these words mean">
        <ul className="mt-1 list-disc pl-5 text-[13px]">
          {(['NOT_IMPLEMENTED', 'CONFIGURED_NOT_VERIFIED', 'LIVE_VERIFIED'] as Verification[]).map((v) => (
            <li key={v}><strong>{VERIFICATION_WORDS[v].label}</strong> - {VERIFICATION_WORDS[v].meaning}</li>
          ))}
        </ul>
      </Callout>

      {mayManage ? (
        <Card>
          <CardHeader title="Add a connection" />
          <CardBody><AddConnectionForm /></CardBody>
        </Card>
      ) : null}

      {integrations.length === 0 ? (
        <Card><CardBody><EmptyState title="No connections yet" description="Add one above. Nothing is contacted until a credential is stored and you press Test connection." /></CardBody></Card>
      ) : (
        integrations.map((i) => {
          const info = PROVIDER_CATALOG[i.provider as Provider];
          const words = VERIFICATION_WORDS[i.verification as Verification];
          const caps = Object.entries(i.capabilities);
          return (
            <Card key={i.id}>
              <CardHeader
                title={`${info?.label ?? i.provider}${i.label !== 'default' ? ` · ${i.label}` : ''}`}
                description={`${i.environment} · status ${i.status.toLowerCase()}${i.accountRef ? ` · ${i.accountRef}` : ''}`}
              />
              <CardBody>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={words?.tone ?? 'neutral'}>{words?.label ?? i.verification}</Badge>
                    {!i.adapterImplemented ? <Badge tone="neutral">No adapter yet</Badge> : null}
                    {i.health ? <Badge tone={i.health === 'ok' ? 'success' : 'warning'}>{i.health}</Badge> : null}
                    <span className="text-xs text-muted">{words?.meaning}</span>
                  </div>
                  <dl className="grid gap-2 text-[13px] sm:grid-cols-3">
                    <div><dt className="text-xs text-muted">Last checked</dt><dd>{when(i.lastCheckedAt)}</dd></div>
                    <div><dt className="text-xs text-muted">Last success</dt><dd>{when(i.lastSuccessAt)}</dd></div>
                    <div><dt className="text-xs text-muted">Last problem</dt><dd>{i.lastError ? `${i.lastErrorClass}: ${i.lastError}` : 'none'}</dd></div>
                  </dl>
                  <div className="text-[13px]">
                    <span className="text-xs text-muted">Credentials: </span>
                    {i.credentials.length === 0 ? 'none stored' : i.credentials.map((c) => `${c.name} (…${c.hint ?? '----'}${c.rotatedAt ? ', rotated' : ''})`).join(' · ')}
                  </div>
                  {caps.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {caps.map(([k, v]) => <Badge key={k} tone={v === 'AUTOMATED' ? 'success' : v === 'UNAVAILABLE' ? 'neutral' : 'info'}>{k.toLowerCase().replaceAll('_', ' ')}: {v.toLowerCase()}</Badge>)}
                    </div>
                  ) : <p className="text-xs text-muted">Capabilities appear here after a real check; nothing is assumed about what this provider allows.</p>}
                  <p className="text-xs text-muted">{info?.humanStep}</p>
                  {mayManage ? (
                    <div className="flex flex-col gap-4 border-t border-line pt-4">
                      <StoreSecretForm integrationId={i.id} names={info?.credentials ?? ['api_key']} canStore={isOwner} />
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <TestConnectionButton integrationId={i.id} />
                        <IntegrationStateForm integrationId={i.id} status={i.status} isOwner={isOwner} />
                      </div>
                    </div>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          );
        })
      )}
    </div>
  );
}
