import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { listAssignments, listDecisions, listManagerModels, listProviderAudit, listProviderKeys, listProviders } from '@/lib/ai/manager-queries';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { Badge, Callout, Card, CardHeader, cx, PageHeader, PermissionDenied } from '@/ui';

import { AddKeyForm, ArchiveProviderForm, DeleteProviderForm, KeyActions, ModelToggle, ProviderForm, ProviderStateForm, RefreshModelsButton, RegisterModelForm, TestConnectionButton } from '../forms';
import { HEALTH_LABEL, HEALTH_TONE, KIND_LABEL } from '../health';

export const metadata: Metadata = { title: 'AI provider' };

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'credentials', label: 'Credentials' },
  { key: 'models', label: 'Models' },
  { key: 'routing', label: 'Routing' },
  { key: 'health', label: 'Health' },
  { key: 'audit', label: 'Audit' },
] as const;

const INR = (minor: number | null) => (minor === null ? '-' : (minor / 100).toFixed(2));

export default async function ProviderPage({ params, searchParams }: { params: Promise<{ providerId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { providerId: raw } = await params;
  const providerId = decodeURIComponent(raw);
  const context = await requireInternal(`/agents/providers/${raw}`);
  if (!can(context, 'ai.provider.read')) return <PermissionDenied />;
  const clock = await agencyClock();
  const isOwner = hasRole(context, 'owner');
  const canManage = can(context, 'ai.provider.manage');
  const canKeys = can(context, 'ai.credential.manage');
  const tabParam = (await searchParams).tab;
  const tab = TABS.some((t) => t.key === tabParam) ? (tabParam as (typeof TABS)[number]['key']) : 'overview';

  const provider = (await listProviders()).find((p) => p.providerId === providerId);
  if (!provider) notFound();

  const base = `/agents/providers/${encodeURIComponent(providerId)}`;
  const [keys, models, assignments, decisions, audit] = await Promise.all([
    tab === 'credentials' || tab === 'overview' || tab === 'health' ? listProviderKeys(providerId) : Promise.resolve([]),
    tab === 'models' || tab === 'overview' || tab === 'routing' ? listManagerModels(providerId) : Promise.resolve([]),
    tab === 'routing' ? listAssignments() : Promise.resolve([]),
    tab === 'routing' || tab === 'health' ? listDecisions({ providerId, limit: 20 }) : Promise.resolve([]),
    tab === 'audit' ? listManagerModels(providerId).then((ms) => listProviderAudit(providerId, ms.map((m) => m.modelId))) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={provider.displayName}
        eyebrow={
          <Link href="/agents/providers" className="underline-offset-2 hover:underline">
            AI providers
          </Link>
        }
        description={`${provider.providerId} · ${KIND_LABEL[provider.kind] ?? provider.kind} · ${provider.isBuiltin ? 'built in' : 'custom'}`}
        meta={
          <span className="flex flex-wrap gap-2">
            <Badge tone={provider.archived ? 'neutral' : provider.enabled ? 'success' : 'neutral'} dot>{provider.archived ? 'Archived' : provider.enabled ? 'Active' : 'Disabled'}</Badge>
            <Badge tone={HEALTH_TONE[provider.healthState] ?? 'neutral'}>{HEALTH_LABEL[provider.healthState] ?? provider.healthState}</Badge>
          </span>
        }
      />

      <nav aria-label="Provider sections" className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === 'overview' ? base : `${base}?tab=${t.key}`}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cx('flex min-h-9 items-center rounded-lg px-3 text-[13px] font-medium transition-colors', tab === t.key ? 'bg-brand text-brand-fg shadow-xs' : 'text-muted hover:bg-surface-hover')}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'overview' ? (
        <>
          <Card>
            <CardHeader title="Status" description="A disabled provider receives nothing, in AUTO or MANUAL. Disabling needs a reason and is audited." />
            <dl className="grid gap-x-6 gap-y-2 px-4 pb-4 text-[13px] sm:grid-cols-2 sm:px-5">
              <Row k="Base URL" v={<code className="font-mono text-xs">{provider.baseUrl}</code>} />
              <Row k="Keys" v={`${provider.usableKeyCount} usable of ${provider.keyCount}`} />
              <Row k="Models" v={`${provider.enabledModelCount} enabled of ${provider.modelCount}`} />
              <Row k="Recognises models" v={<code className="font-mono text-xs">{[...provider.matchPrefixes.map((p) => `${p}*`), ...provider.matchContains.map((c) => `*${c}*`)].join(', ') || 'only models assigned to it by hand'}</code>} />
              <Row k="Priority" v={provider.priority} />
              <Row k="Timeout · retries" v={`${provider.timeoutMs} ms · ${provider.retryMax}`} />
            </dl>
            {canManage && !provider.archived ? (
              <div className="flex flex-col gap-3 border-t border-line px-4 py-4 sm:px-5">
                <ProviderStateForm providerId={provider.providerId} enabled={provider.enabled} />
                <div className="flex flex-wrap items-center gap-3">
                  <TestConnectionButton providerId={provider.providerId} />
                  <RefreshModelsButton providerId={provider.providerId} />
                </div>
              </div>
            ) : null}
          </Card>
          {canManage && !provider.archived ? (
            <Card>
              <CardHeader title="Settings" description={provider.isBuiltin ? 'A built-in provider can be re-pointed (a gateway or regional endpoint) but not deleted.' : 'The connection and the way this provider recognises its models.'} />
              <ProviderForm editing draft={provider} />
            </Card>
          ) : null}
          {isOwner && !provider.archived ? (
            <Card>
              <CardHeader title="Retire" description="Archiving stops all use and keeps the history. Deleting is only possible for a custom provider with no models or runs on record." />
              <div className="flex flex-wrap items-start gap-6 px-4 pb-4 sm:px-5">
                <ArchiveProviderForm providerId={provider.providerId} />
                {!provider.isBuiltin ? <DeleteProviderForm providerId={provider.providerId} /> : null}
              </div>
            </Card>
          ) : null}
        </>
      ) : null}

      {tab === 'credentials' ? (
        <Card>
          <CardHeader
            title="Keys"
            description="Several keys per provider are used in order; a rejected key is parked and never asked again until you re-enable or replace it, and a rate-limited key rests. A key is never shown - only its label and last characters."
          />
          {keys.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">
              No stored key.{provider.isBuiltin ? ' A key set in the hosting environment, if any, still serves this provider.' : ''}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {keys.map((k) => (
                <li key={k.id} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{k.label}</span>
                    <code className="font-mono text-xs text-muted">{k.hint ? `…${k.hint}` : 'stored'}</code>
                    <Badge tone={k.enabled ? 'success' : 'neutral'} dot>{k.enabled ? 'enabled' : 'disabled'}</Badge>
                    <Badge tone={HEALTH_TONE[k.healthState] ?? 'neutral'}>{HEALTH_LABEL[k.healthState] ?? k.healthState}</Badge>
                    <Badge tone="neutral">{k.environment}</Badge>
                    <span className="text-xs text-faint">order {k.priority}</span>
                  </div>
                  <p className="text-xs text-muted">
                    added {clock.dateTime(k.createdAt)}
                    {k.createdByName ? ` by ${k.createdByName}` : ''}
                    {k.rotatedAt ? ` · replaced ${clock.dateTime(k.rotatedAt)}` : ''}
                    {k.lastUsedAt ? ` · last used ${clock.dateTime(k.lastUsedAt)}` : ' · never used'}
                    {k.cooldownUntil && new Date(k.cooldownUntil).getTime() > Date.now() ? ` · resting until ${clock.dateTime(k.cooldownUntil)}` : ''}
                  </p>
                  {k.lastError ? <p className="text-xs text-danger">last error: {k.lastError}</p> : null}
                  {canKeys ? <KeyActions providerId={provider.providerId} keyId={k.id} enabled={k.enabled} /> : null}
                </li>
              ))}
            </ul>
          )}
          {canKeys ? <AddKeyForm providerId={provider.providerId} /> : <p className="border-t border-line px-4 py-3 text-xs text-muted sm:px-5">Adding and replacing keys is the owner&apos;s; shown read-only for your role.</p>}
        </Card>
      ) : null}

      {tab === 'models' ? (
        <Card>
          <CardHeader title="Models" description="Discovered models arrive disabled - nothing is routed to a model until you enable it. A model the provider stops listing is marked, never deleted." actions={canManage ? <RefreshModelsButton providerId={provider.providerId} /> : undefined} />
          {models.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No model known yet. Refresh the list from the provider, or register one by hand.</p>
          ) : (
            <ul className="divide-y divide-line">
              {models.map((m) => (
                <li key={m.modelId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
                  <div className="min-w-0">
                    <code className="font-mono text-xs">{m.modelId}</code>
                    <p className="text-xs text-muted">
                      {m.source === 'discovered' ? 'discovered' : 'registered by hand'}
                      {m.contextTokens ? ` · ${m.contextTokens.toLocaleString('en-IN')} tokens` : ''}
                      {m.toolCalling === true ? ' · tools' : m.toolCalling === false ? ' · no tools' : ''}
                      {m.capabilities.length ? ` · ${m.capabilities.join(', ')}` : ''}
                      {m.inputCostMinorPerMtok !== null || m.outputCostMinorPerMtok !== null ? ` · ₹${INR(m.inputCostMinorPerMtok)} / ₹${INR(m.outputCostMinorPerMtok)} per Mtok` : ' · no price recorded'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {m.status !== 'available' ? <Badge tone="warning">{m.status}</Badge> : null}
                    <Badge tone={m.enabled ? 'success' : 'neutral'} dot>{m.enabled ? 'enabled' : 'disabled'}</Badge>
                    {canManage ? <ModelToggle providerId={provider.providerId} modelId={m.modelId} enabled={m.enabled} /> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {canManage ? <RegisterModelForm providerId={provider.providerId} /> : null}
        </Card>
      ) : null}

      {tab === 'routing' ? (
        <>
          <Card>
            <CardHeader title="Where this provider is used" description="Manual assignments that name it, as the primary or as a fallback. In AUTO it is chosen like any other enabled provider." />
            {(() => {
              const mine = assignments.filter((a) => a.providerId === provider.providerId || a.fallbacks.some((f) => f.providerId === provider.providerId));
              return mine.length === 0 ? (
                <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No agent is assigned to it.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {mine.map((a) => (
                    <li key={a.agentKey} className="px-4 py-2.5 text-[13px] sm:px-5">
                      <code className="font-mono text-xs">{a.agentKey}</code> - {a.providerId === provider.providerId ? 'primary' : 'fallback'} ·{' '}
                      <code className="font-mono text-xs">{a.providerId === provider.providerId ? a.modelId : a.fallbacks.find((f) => f.providerId === provider.providerId)?.modelId}</code>
                    </li>
                  ))}
                </ul>
              );
            })()}
            <p className="px-4 pb-4 text-xs text-muted sm:px-5">
              Change assignments and the mode on <Link href="/agents/providers#routing" className="text-brand underline-offset-2 hover:underline">the AI providers page</Link>.
            </p>
          </Card>
          <Decisions decisions={decisions} clock={clock} />
        </>
      ) : null}

      {tab === 'health' ? (
        <>
          <Card>
            <CardHeader title="Health" description="What the system observed - a runtime condition, not a setting. It updates from real calls and from connection tests." actions={canManage ? <TestConnectionButton providerId={provider.providerId} /> : undefined} />
            <dl className="grid gap-x-6 gap-y-2 px-4 pb-4 text-[13px] sm:grid-cols-2 sm:px-5">
              <Row k="State" v={<Badge tone={HEALTH_TONE[provider.healthState] ?? 'neutral'}>{HEALTH_LABEL[provider.healthState] ?? provider.healthState}</Badge>} />
              <Row k="Last checked" v={provider.healthCheckedAt ? clock.dateTime(provider.healthCheckedAt) : 'never'} />
              <Row k="Last success" v={provider.lastSuccessAt ? clock.dateTime(provider.lastSuccessAt) : 'never'} />
              <Row k="Last failure" v={provider.lastFailureAt ? clock.dateTime(provider.lastFailureAt) : 'never'} />
              <Row k="Last latency" v={provider.lastLatencyMs === null ? '-' : `${provider.lastLatencyMs} ms`} />
              <Row k="Calls counted" v={provider.recentCalls} />
            </dl>
            {provider.healthDetail ? <p className="px-4 pb-4 text-xs text-muted sm:px-5">{provider.healthDetail}</p> : null}
          </Card>
          <Card>
            <CardHeader title="Keys" />
            <ul className="divide-y divide-line">
              {keys.length === 0 ? <li className="px-4 py-3 text-[13px] text-muted sm:px-5">No stored keys.</li> : null}
              {keys.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="font-semibold">{k.label}</span>
                  <Badge tone={HEALTH_TONE[k.healthState] ?? 'neutral'}>{HEALTH_LABEL[k.healthState] ?? k.healthState}</Badge>
                  {k.consecutiveFailures > 0 ? <span className="text-xs text-warning">{k.consecutiveFailures} failures in a row</span> : null}
                  {k.lastError ? <span className="text-xs text-muted">{k.lastError}</span> : null}
                </li>
              ))}
            </ul>
          </Card>
          <Decisions decisions={decisions} clock={clock} />
        </>
      ) : null}

      {tab === 'audit' ? (
        <Card>
          <CardHeader title="Audit" description="Every change to this provider, its keys and its models - who, when, what. Secrets are never part of an audit row." />
          {audit.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing recorded yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {audit.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="text-xs text-muted">{clock.dateTime(e.at)}</span>
                  <code className="font-mono text-xs">{e.action}</code>
                  <span className="text-xs text-muted">{e.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === 'overview' && keys.length === 0 && provider.enabled ? (
        <Callout tone="warning" title="No stored key">
          {provider.isBuiltin ? 'This provider works only if its key is set in the hosting environment. ' : 'Nothing can be routed to this provider yet. '}
          Add a key on the Credentials tab.
        </Callout>
      ) : null}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}

function Decisions({ decisions, clock }: { decisions: Awaited<ReturnType<typeof listDecisions>>; clock: Awaited<ReturnType<typeof agencyClock>> }) {
  return (
    <Card>
      <CardHeader title="Recent decisions that used this provider" description="Each shows who was considered, why anything was left out, and every attempt." />
      {decisions.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">None yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {decisions.map((d) => (
            <li key={d.id} className="flex flex-col gap-1 px-4 py-2.5 text-[13px] sm:px-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">{clock.dateTime(d.createdAt)}</span>
                <code className="font-mono text-xs">{d.agentKey}</code>
                <Badge tone={d.mode === 'manual' ? 'warning' : 'info'}>{d.mode}</Badge>
                <Badge tone={d.outcome === 'succeeded' ? 'success' : d.outcome === 'blocked' ? 'danger' : 'warning'}>{d.outcome}</Badge>
                <code className="font-mono text-xs">{d.modelId}</code>
                {d.selectionSource ? <span className="text-xs text-faint">{d.selectionSource.replace('_', ' ')}</span> : null}
                {d.fallbackUsed ? <Badge tone="warning">fallback used</Badge> : null}
              </div>
              {d.considered.filter((c) => c.excluded).length > 0 ? (
                <p className="text-xs text-muted">left out: {d.considered.filter((c) => c.excluded).map((c) => `${c.model} (${c.excluded})`).join('; ')}</p>
              ) : null}
              {d.attempts.length > 1 ? <p className="text-xs text-muted">attempts: {d.attempts.map((a) => `${a.providerId}/${a.model} ${a.ok ? 'ok' : `failed${a.error ? `: ${a.error}` : ''}`}`).join(' → ')}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
