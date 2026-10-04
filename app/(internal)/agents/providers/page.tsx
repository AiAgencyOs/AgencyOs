import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { aiStatus } from '@/lib/admin/agent-status';
import { listAssignments, listDecisions, listManagerModels, listProviders, readRoutingMode, readUsageOverview } from '@/lib/ai/manager-queries';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { Badge, Callout, Card, CardHeader, EmptyState, IconAgents, IconSettings, IconSparkle, IconUsage, PageHeader, PermissionDenied, Stat, StatGrid } from '@/ui';

import { AssignmentForm, ProviderForm, RoutingModeForm } from './forms';
import { HEALTH_LABEL, HEALTH_TONE, KIND_LABEL } from './health';

export const metadata: Metadata = { title: 'AI providers' };

/**
 * The AI Provider Manager. One place for every AI provider: what is connected, which keys it holds, which models it serves, how it
 * is doing - and how the orchestrator chooses between them.
 *
 *   • AUTO  - the orchestrator picks among the providers and models enabled here, explaining every choice.
 *   • MANUAL - an agent runs on exactly the provider and model assigned to it; nothing is substituted, an assignment that cannot
 *     run blocks the run and raises an alert, and only an explicit fallback may serve.
 *
 * Switching modes keeps the other mode's settings. Nothing here ever shows a key.
 */
export default async function ProvidersPage() {
  const context = await requireInternal('/agents/providers');
  if (!can(context, 'ai.provider.read')) return <PermissionDenied />;
  const clock = await agencyClock();
  const isOwner = hasRole(context, 'owner');
  const canManage = can(context, 'ai.provider.manage');

  const [providers, models, routing, assignments, decisions, ai, overview] = await Promise.all([
    listProviders(),
    listManagerModels(),
    readRoutingMode(),
    listAssignments(),
    listDecisions({ limit: 12 }),
    aiStatus(),
    readUsageOverview(),
  ]);

  const live = providers.filter((p) => !p.archived);
  const enabledProviders = live.filter((p) => p.enabled);
  const usableKeys = enabledProviders.reduce((n, p) => n + p.usableKeyCount, 0);
  const enabledModels = models.filter((m) => m.enabled && m.status === 'available');

  // Only what could actually serve: an enabled, un-archived provider with a usable key, and an enabled model it owns.
  const servable = new Set(enabledProviders.filter((p) => p.usableKeyCount > 0).map((p) => p.providerId));
  const options = enabledModels
    .filter((m) => servable.has(m.provider))
    .map((m) => ({ value: `${m.provider}::${m.modelId}`, label: `${m.provider} · ${m.modelId}` }));
  const byAgent = new Map(assignments.map((a) => [a.agentKey, a]));
  const optionLabel = (providerId: string, modelId: string) => `${providerId}::${modelId}`;
  const unassigned = ai.agents.filter((a) => a.enabled && !byAgent.has(a.key)).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="AI providers"
        description="Every AI provider, key and model in one place, and how the orchestrator chooses between them."
        meta={<Badge tone={routing.mode === 'manual' ? 'warning' : 'success'}>{routing.mode === 'manual' ? 'MANUAL routing' : 'AUTO routing'}</Badge>}
        actions={
          <span className="flex items-center gap-4">
            <Link href="/agents/routing-log" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
              Routing log
            </Link>
            <Link href="/agents/routing" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
              Policies &amp; budgets
            </Link>
          </span>
        }
      />

      <StatGrid>
        <Stat label="Providers" value={`${enabledProviders.length} active`} caption={`${live.length} registered · ${live.length - enabledProviders.length} disabled`} tone={enabledProviders.length > 0 ? 'success' : 'warning'} icon={<IconAgents size={16} />} href="#providers" />
        <Stat label="Usable keys" value={usableKeys} caption={usableKeys > 0 ? 'enabled, not rejected, not resting' : 'No agent can run without one'} tone={usableKeys > 0 ? 'success' : 'warning'} icon={<IconSparkle size={16} />} href="#providers" />
        <Stat label="Enabled models" value={enabledModels.length} caption={`${models.length} known`} tone={enabledModels.length > 0 ? 'success' : 'neutral'} icon={<IconUsage size={16} />} href="#providers" />
        <Stat label="Routing mode" value={routing.mode.toUpperCase()} caption={`configuration v${routing.version}`} icon={<IconSettings size={16} />} href="#routing" />
      </StatGrid>

      <Card id="routing">
        <CardHeader
          title="Routing mode"
          description={
            routing.mode === 'auto'
              ? 'AUTO: the orchestrator chooses the provider and model for each run from what is enabled here, and records why.'
              : 'MANUAL: each agent runs exactly on the provider and model assigned below. Nothing is substituted.'
          }
          actions={routing.changedAt ? <span className="text-xs text-muted">changed {clock.dateTime(routing.changedAt)}{routing.reason ? ` - ${routing.reason}` : ''}</span> : undefined}
        />
        {isOwner ? <RoutingModeForm mode={routing.mode} /> : <p className="px-4 py-3 text-xs text-muted sm:px-5">Only the owner switches the routing mode; shown read-only for your role.</p>}
        {routing.mode === 'manual' && unassigned > 0 ? (
          <div className="px-4 pb-4 sm:px-5">
            <Callout tone="warning" title={`${unassigned} enabled agent${unassigned === 1 ? ' has' : 's have'} no assignment`}>
              In MANUAL mode an agent with no assignment is blocked and you are alerted - the system will not guess a model for it. Assign one below, or switch to AUTO.
            </Callout>
          </div>
        ) : null}
      </Card>

      <Card id="providers">
        <CardHeader title="Providers" description="Open one to manage its keys, models and health. A disabled provider receives nothing, in either mode." />
        {live.length === 0 ? (
          <EmptyState title="No provider yet" description="Add a provider below, then a key." />
        ) : (
          <ul className="divide-y divide-line">
            {live.map((p) => (
              <li key={p.providerId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0">
                  <Link href={`/agents/providers/${encodeURIComponent(p.providerId)}`} className="text-sm font-semibold underline-offset-2 hover:underline">
                    {p.displayName}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    <code className="font-mono">{p.providerId}</code> · {KIND_LABEL[p.kind] ?? p.kind}
                    {p.isBuiltin ? ' · built in' : ' · custom'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={p.enabled ? 'success' : 'neutral'} dot>{p.enabled ? 'Active' : 'Disabled'}</Badge>
                  <Badge tone={HEALTH_TONE[p.healthState] ?? 'neutral'}>{HEALTH_LABEL[p.healthState] ?? p.healthState}</Badge>
                  <span className="text-muted">{p.usableKeyCount}/{p.keyCount} keys usable</span>
                  <span className="text-muted">{p.enabledModelCount}/{p.modelCount} models enabled</span>
                  {p.healthCheckedAt ? <span className="text-faint">checked {clock.dateTime(p.healthCheckedAt)}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <details className="border-t border-line">
            <summary className="cursor-pointer px-4 py-3 text-[13px] font-semibold sm:px-5">Add a custom provider</summary>
            <ProviderForm />
          </details>
        ) : null}
      </Card>

      <Card id="assignments">
        <CardHeader
          title="Manual assignments"
          description={routing.mode === 'manual' ? 'Used now: each agent runs exactly on its row. A fallback is used only if you list one.' : 'Kept for when you switch to MANUAL. AUTO ignores them.'}
        />
        {options.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing can be assigned yet: enable a provider that has a usable key, then enable at least one of its models.</p>
        ) : (
          <ul className="divide-y divide-line">
            {ai.agents.map((a) => {
              const row = byAgent.get(a.key);
              return (
                <li key={a.key} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{a.displayName}</span>
                    <code className="font-mono text-[11px] text-muted">{a.key}</code>
                    {!a.enabled ? <Badge tone="neutral">agent off</Badge> : null}
                    {row ? <Badge tone="info">assigned</Badge> : <Badge tone="neutral">not assigned</Badge>}
                    <span className="text-xs text-faint">default model {a.defaultModel}</span>
                  </div>
                  {isOwner ? (
                    <AssignmentForm
                      // Remount when the saved assignment changes, so the selects show what was saved rather than what was typed before.
                      key={`${a.key}|${row?.providerId}|${row?.modelId}|${(row?.fallbacks ?? []).map((f) => f.modelId).join(',')}|${row?.note ?? ''}`}
                      agentKey={a.key}
                      options={options}
                      primary={row ? optionLabel(row.providerId, row.modelId) : ''}
                      fallbacks={(row?.fallbacks ?? []).map((f) => optionLabel(f.providerId, f.modelId))}
                      note={row?.note ?? ''}
                    />
                  ) : (
                    <p className="text-xs text-muted">{row ? `${row.providerId} · ${row.modelId}${row.fallbacks.length ? ` (fallbacks: ${row.fallbacks.map((f) => f.modelId).join(', ')})` : ''}` : 'No assignment.'}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card id="usage">
        <CardHeader title="Usage this month, by provider" description={`Since ${clock.dateTime(overview.since)}. Tokens are what each provider reported; cost is only from prices you recorded - a run on a model with no price has an unknown cost, not a zero one.`} />
        {overview.rows.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing has run this month.</p>
        ) : (
          <ul className="divide-y divide-line">
            {overview.rows.map((u) => (
              <li key={u.providerId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                <span className="font-medium">{u.providerId}</span>
                <span className="text-xs text-muted">
                  {u.runs} runs{u.failed ? ` (${u.failed} failed)` : ''}
                  {u.capabilityCalls ? ` · ${u.capabilityCalls} embedding/image/voice calls` : ''} · {(u.inputTokens + u.outputTokens).toLocaleString('en-IN')} tokens · ₹{(u.costMinor / 100).toFixed(2)}
                  {u.unpricedRuns ? ` · ${u.unpricedRuns} unpriced` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card id="decisions">
        <CardHeader title="Recent routing decisions" description="Why each run went where it did. The full record is on the routing log." />
        {decisions.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No agent has run since routing decisions started being recorded.</p>
        ) : (
          <ul className="divide-y divide-line">
            {decisions.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] sm:px-5">
                <span className="text-xs text-muted">{clock.dateTime(d.createdAt)}</span>
                <code className="font-mono text-xs">{d.agentKey}</code>
                <Badge tone={d.mode === 'manual' ? 'warning' : 'info'}>{d.mode}</Badge>
                <Badge tone={d.outcome === 'succeeded' ? 'success' : d.outcome === 'blocked' ? 'danger' : 'warning'}>{d.outcome}</Badge>
                <span className="font-mono text-xs">{d.providerId ? `${d.providerId} · ${d.modelId}` : '-'}</span>
                {d.fallbackUsed ? <Badge tone="warning">fallback used</Badge> : null}
                {d.blockedReason ? <span className="basis-full text-xs text-danger">{d.blockedReason}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
