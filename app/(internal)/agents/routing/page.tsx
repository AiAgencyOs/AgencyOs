import type { Metadata } from 'next';
import Link from 'next/link';

import { aiStatus } from '@/lib/admin/agent-status';
import { agencyClock } from '@/lib/admin/agency-clock';
import { listRoutingPolicies } from '@/lib/admin/model-routing';
import { listModels, listVaultEntries } from '@/lib/admin/model-registry';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Card, CardHeader, PageHeader, PermissionDenied, StatusBadge } from '@/ui';

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
 * does not select the ciphertext columns. No "revoke key" control: vault.ts
 * has no delete or revoke function, and a button onto a row deletion the
 * module does not own would be a door nobody designed.
 *
 * The matrix is categories × their policy. It is not categories × agents:
 * nothing in the schema or the registry binds an agent to a category (the
 * resolver routes by capability and the category's policy), so a cell
 * claiming "this agent uses this category" would be invented.
 */
export default async function ModelRoutingPage() {
  const context = await requireInternal('/agents/routing');
  if (!can(context.role, 'organization.settings')) return <PermissionDenied />;
  const clock = await agencyClock();

  const [policies, models, vault, ai] = await Promise.all([listRoutingPolicies(), listModels(), listVaultEntries(), aiStatus()]);
  const vaultByProvider = new Map(vault.map((v) => [v.provider, v]));

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
                <span className="text-xs text-muted">
                  {entry ? `stored ${clock.dateTime(entry.updatedAt)} by ${entry.updatedByName}` : 'no vault key'}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="px-4 pb-3 text-xs text-muted sm:px-5">
          Revoking a stored key has no door yet; storing a new one replaces it.
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
          description="Every category and the policy in force. Agents are not bound to a category anywhere in the schema, so the per-agent view is each agent's own default model, below."
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
        <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-xs text-muted sm:px-5">
          {ai.agents.map((a) => (
            <li key={a.key}>
              <Link href={`/agents/${a.key}`} className="underline-offset-2 hover:underline">
                {a.key}
              </Link>{' '}
              → <code>{a.defaultModel ?? '—'}</code>
            </li>
          ))}
        </ul>
      </Card>

      <div className="flex flex-col gap-3">
        {policies.map((p) => (
          <RoutingPolicyForm key={p.category} policy={p} />
        ))}
      </div>
    </div>
  );
}
