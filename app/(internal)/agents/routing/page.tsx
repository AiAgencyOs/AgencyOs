import type { Metadata } from 'next';
import Link from 'next/link';

import { listAgentRoutingOverrides } from '@/lib/admin/agent-routing';
import { aiStatus } from '@/lib/admin/agent-status';
import { agencyClock } from '@/lib/admin/agency-clock';
import { listRoutingPolicies } from '@/lib/admin/model-routing';
import { listModels, listVaultEntries } from '@/lib/admin/model-registry';
import { ROUTING_CATEGORIES, categoryForAgent, effectiveModel } from '@/lib/ai/model-choice';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Card, CardHeader, PageHeader, PermissionDenied, StatusBadge } from '@/ui';

import { RevokeProviderCredentialForm } from '../../settings/revoke-provider-form';
import { RoutingOverrideForm } from './override-form';
import { RoutingPolicyForm } from './routing-form';

export const metadata: Metadata = { title: 'Model routing' };

const VAULT_PROVIDERS = ['anthropic', 'openai', 'gemini', 'xai', 'openrouter'] as const;

/**
 * Model Routing & providers — SCR-064, ai.routing_policies (ADM-84). Per
 * category, not per agent. `routing_policies_write` already admits
 * owner/ops_admin directly under RLS (core.is_admin()) — the only gap here
 * was the screen; unlike the qa/scope doors, no write path was missing.
 *
 * `ai.models` ships empty by design (ADM-84 deferred the second provider),
 * so preferred models are free text rather than a picker against a registry
 * with nothing in it — and the registry table below says "empty by design"
 * rather than showing rows nobody established.
 *
 * The vault list shows provider, when and by whom — never a key; the reader
 * does not select the ciphertext columns. "Revoke" (SCR-064, 20260929210000)
 * is owner-only and goes through `ai.revoke_provider_credential`, which
 * deletes the row and audits who set the key and when — never what.
 *
 * The grid is agents × categories (SCR-064). Each agent has ONE category the
 * runner asks about (`AGENT_CATEGORY` in src/lib/ai/model-choice.ts), marked
 * in its row; a cell shows the model the runner would take there — the
 * owner's (agent, category) override first, then the category policy, then
 * the agent's own default — and an owner sets or clears an override through
 * `ai.set_agent_routing_override`. Overrides in an agent's other cells are
 * recorded and shown, and the runner never reads them; the grid says so.
 */
export default async function ModelRoutingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireInternal('/agents/routing');
  if (!can(context.role, 'organization.settings')) return <PermissionDenied />;
  const clock = await agencyClock();
  const isOwner = context.role === 'owner';
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

  const [policies, models, vault, ai, overrides] = await Promise.all([
    listRoutingPolicies(),
    listModels(),
    listVaultEntries(),
    aiStatus(),
    listAgentRoutingOverrides(),
  ]);
  const vaultByProvider = new Map(vault.map((v) => [v.provider, v]));
  const policyByCategory = new Map(policies.map((p) => [p.category, p]));
  const overrideByCell = new Map(overrides.map((o) => [`${o.agentKey}:${o.category}`, o]));

  const selectedAgent = ai.agents.some((a) => a.key === one(params.agent)) ? one(params.agent) : (ai.agents[0]?.key ?? '');
  const selectedCategory = (ROUTING_CATEGORIES as readonly string[]).includes(one(params.category))
    ? one(params.category)
    : (categoryForAgent(selectedAgent) ?? ROUTING_CATEGORIES[0]);
  const selectedOverride = overrideByCell.get(`${selectedAgent}:${selectedCategory}`) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Model routing & providers"
        description="What each category of agent optimises for, and which model it prefers. An admin override wins outright over the resolver's own preference."
        actions={
          <Link href="/agents" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
            Registry &amp; key vault
          </Link>
        }
      />

      <Card>
        <CardHeader
          title="Provider vault"
          description="Which providers hold a stored key, when it was set and by whom. The key itself is never read here. Env-set keys still take precedence."
          actions={
            <Link href="/agents#vault" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
              Store a key
            </Link>
          }
        />
        <ul className="divide-y divide-line">
          {VAULT_PROVIDERS.map((provider) => {
            const entry = vaultByProvider.get(provider);
            const registered = ai.providers.includes(provider);
            return (
              <li key={provider} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                <span className="flex items-center gap-2">
                  <Badge tone={entry ? 'success' : 'neutral'} dot>
                    {provider}
                  </Badge>
                  {registered ? <span className="text-xs text-success">registered with the resolver</span> : null}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  {entry ? `stored ${clock.dateTime(entry.updatedAt)} by ${entry.updatedByName}` : 'no vault key'}
                  {entry && isOwner ? <RevokeProviderCredentialForm provider={provider} /> : null}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="px-4 pb-3 text-xs text-muted sm:px-5">
          Storing a new key replaces the old one. Revoking is the owner&apos;s alone and is audited; a key set in the environment cannot be revoked from here.
        </p>
      </Card>

      <Card>
        <CardHeader
          title="Model registry"
          description="ai.models — the models the resolver may name, with their declared capabilities and rates."
        />
        {models.length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-muted sm:px-5">
            Empty by design (ADM-84): no model row has been established for this organization, so routing falls back to
            capability matching and the free-text preferences below.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-normal sm:px-5">Model</th>
                  <th className="px-4 py-2 font-normal">Provider</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                  <th className="px-4 py-2 font-normal">Capabilities</th>
                  <th className="px-4 py-2 text-right font-normal">Context</th>
                  <th className="px-4 py-2 text-right font-normal sm:pr-5">₹ / Mtok in · out</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={`${m.provider}/${m.modelId}`} className="border-b border-line">
                    <td className="px-4 py-2 font-mono text-xs sm:px-5">{m.modelId}</td>
                    <td className="px-4 py-2">{m.provider}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={m.status} />
                    </td>
                    <td className="px-4 py-2 text-muted">{m.capabilities.join(', ') || '—'}</td>
                    <td className="px-4 py-2 text-right tabular">{m.contextTokens ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular sm:pr-5">
                      {m.inputCostMinorPerMtok !== null ? (m.inputCostMinorPerMtok / 100).toFixed(2) : '—'} ·{' '}
                      {m.outputCostMinorPerMtok !== null ? (m.outputCostMinorPerMtok / 100).toFixed(2) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Routing matrix"
          description="Every category and the policy in force. The grid below says which model each agent would actually get."
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-normal sm:px-5">Category</th>
                <th className="px-4 py-2 font-normal">Optimises for</th>
                <th className="px-4 py-2 font-normal">Preferred models</th>
                <th className="px-4 py-2 font-normal">Admin override</th>
                <th className="px-4 py-2 font-normal sm:pr-5">Configured</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.category} className="border-b border-line">
                  <td className="px-4 py-2 font-medium sm:px-5">{p.category.replace('_', ' ')}</td>
                  <td className="px-4 py-2">{p.optimiseFor}</td>
                  <td className="px-4 py-2 font-mono text-xs">{p.preferredModels.join(', ') || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs">{p.adminOverrideModel ?? '—'}</td>
                  <td className="px-4 py-2 sm:pr-5">
                    <Badge tone={p.configured ? 'success' : 'neutral'}>{p.configured ? 'set' : 'resolver default'}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Routing by agent"
          description={
            isOwner
              ? 'Agents × categories. A cell is the model the runner would take: your override for that cell, else the category policy, else the agent’s own default. Click a cell to set or clear its override. The runner asks only the marked cell in each row.'
              : 'Agents × categories. A cell is the model the runner would take: the owner’s override for that cell, else the category policy, else the agent’s own default. Only the owner may change it. The runner asks only the marked cell in each row.'
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-normal sm:px-5">Agent</th>
                <th className="px-4 py-2 font-normal">Default</th>
                {ROUTING_CATEGORIES.map((c) => (
                  <th key={c} className="px-3 py-2 font-normal">
                    {c.replace('_', ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ai.agents.map((a) => {
                const routed = categoryForAgent(a.key);
                return (
                  <tr key={a.key} className="border-b border-line">
                    <td className="px-4 py-2 sm:px-5">
                      <Link href={`/agents/${a.key}`} className="font-medium underline-offset-2 hover:underline">
                        {a.displayName}
                      </Link>
                      {routed === null ? <span className="block text-[11px] text-muted">no category — the runner uses the default</span> : null}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-muted">{a.defaultModel ?? '—'}</td>
                    {ROUTING_CATEGORIES.map((c) => {
                      const policy = policyByCategory.get(c);
                      const override = overrideByCell.get(`${a.key}:${c}`) ?? null;
                      const chosen = effectiveModel({
                        override: override ? { preferredModels: override.preferredModels } : null,
                        policy: policy ? { adminOverrideModel: policy.adminOverrideModel, preferredModels: policy.preferredModels } : null,
                        agentDefault: a.defaultModel ?? '',
                      });
                      const consulted = routed === c;
                      const selected = a.key === selectedAgent && c === selectedCategory;
                      const cell = (
                        <span className="flex flex-col gap-0.5">
                          <code className={`text-xs ${consulted ? '' : 'text-muted'}`}>{chosen.model || '—'}</code>
                          <span className="text-[10px] text-muted">
                            {chosen.source === 'agent_override'
                              ? 'override'
                              : chosen.source === 'policy_override'
                                ? 'policy override'
                                : chosen.source === 'policy_preference'
                                  ? 'policy preference'
                                  : 'agent default'}
                            {consulted ? ' · runner asks here' : ''}
                          </span>
                        </span>
                      );
                      return (
                        <td key={c} className={`px-3 py-2 align-top ${consulted ? 'bg-brand/5' : ''} ${selected ? 'ring-1 ring-inset ring-brand' : ''}`}>
                          {isOwner ? (
                            <Link href={`/agents/routing?agent=${a.key}&category=${c}#override`} scroll={false} className="block rounded hover:bg-surface-2">
                              {cell}
                            </Link>
                          ) : (
                            cell
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {isOwner ? (
          <div id="override" className="px-4 pb-4 sm:px-5">
            <RoutingOverrideForm
              key={`${selectedAgent}:${selectedCategory}`}
              agents={ai.agents.map((a) => ({ key: a.key, displayName: a.displayName }))}
              categories={ROUTING_CATEGORIES}
              initial={{
                agentKey: selectedAgent,
                category: selectedCategory,
                preferredModels: selectedOverride?.preferredModels ?? [],
                note: selectedOverride?.note ?? null,
              }}
            />
          </div>
        ) : null}
      </Card>

      <div className="flex flex-col gap-3">
        {policies.map((p) => (
          <RoutingPolicyForm key={p.category} policy={p} />
        ))}
      </div>
    </div>
  );
}
