import type { Metadata } from 'next';
import Link from 'next/link';

import { listAgentRoutingOverrides } from '@/lib/admin/agent-routing';
import { aiStatus } from '@/lib/admin/agent-status';
import { listRoutingPolicies } from '@/lib/admin/model-routing';
import { listModels, listVaultEntries } from '@/lib/admin/model-registry';
import { listFallbackChains, listModelBudgets, listProviderBudgets } from '@/modules/agents/models-queries';
import { ROUTING_CATEGORIES, categoryForAgent, effectiveModel } from '@/lib/ai/model-choice';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { listToolDefinitions } from '@/modules/agents/permissions-schema';
import { listToolPermissionsForTool } from '@/modules/agents/tool-detail-queries';
import { readOperationalSettings, settingInstant, settingText } from '@/lib/admin/settings';
import { Badge, Callout, Card, CardHeader, DataTable, IconAgents, IconSettings, IconSparkle, IconUsage, PageHeader, PermissionDenied, Stat, StatGrid, StatusBadge, type Column } from '@/ui';

import { VerifyAiProviderForm } from '../../settings/forms';

import { AddModelForm, FallbackChainsPanel, ModelBudgetsPanel, ProviderBudgetsPanel, RetireModelForm } from './model-registry-panel';
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
 * Decision 2026-09-30: ADM-84 reversed — the owner manages models in the
 * panel. The registry below is the owner's to add to and retire from
 * (`ai.add_model` / `ai.retire_model`, audited); a fallback chain per work
 * class (`ai.fallback_chains`) is what the runner tries after the agent
 * override and the category policy and before the agent's default; and a
 * monthly cap per provider (`ai.provider_budgets`) is what the runner refuses
 * past, recorded like a policy refusal. Policy preferences stay free text so
 * a tenant that has registered nothing keeps routing exactly as before.
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
  if (!can(context, 'organization.settings')) return <PermissionDenied />;
  const isOwner = hasRole(context, 'owner');
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

  const [policies, models, vault, ai, overrides, chains, budgets, settings, toolPermissions, modelBudgets] = await Promise.all([
    listRoutingPolicies(),
    listModels(),
    listVaultEntries(),
    aiStatus(),
    listAgentRoutingOverrides(),
    listFallbackChains(),
    listProviderBudgets(),
    readOperationalSettings(),
    Promise.all(listToolDefinitions().map(async (t) => ({ tool: t, permissions: await listToolPermissionsForTool(t.name) }))),
    listModels().then((rows) => listModelBudgets(rows.filter((m) => m.status !== 'retired').map((m) => m.modelId))),
  ]);
  const providerVerifiedAt = settingInstant(settings, 'ai_provider_verified_at');
  const providerVerifiedModel = settingText(settings, 'ai_provider_verified_model');
  const storedKeys = VAULT_PROVIDERS.filter((p) => vault.some((v) => v.provider === p)).length;
  const configuredPolicies = policies.filter((p) => p.configured).length;
  const chainsSet = chains.filter((c) => c.modelIds.length > 0).length;
  const availableModels = models.filter((m) => m.status === 'available').map((m) => m.modelId);
  const policyByCategory = new Map(policies.map((p) => [p.category, p]));
  const overrideByCell = new Map(overrides.map((o) => [`${o.agentKey}:${o.category}`, o]));

  const selectedAgent = ai.agents.some((a) => a.key === one(params.agent)) ? one(params.agent) : (ai.agents[0]?.key ?? '');
  const selectedCategory = (ROUTING_CATEGORIES as readonly string[]).includes(one(params.category))
    ? one(params.category)
    : (categoryForAgent(selectedAgent) ?? ROUTING_CATEGORIES[0]);
  const selectedOverride = overrideByCell.get(`${selectedAgent}:${selectedCategory}`) ?? null;

  // Bucket F: the three hand-rolled tables move to the shared DataTable —
  // one description each, a real table from `lg` up and a card list below,
  // so a phone gets a readable list rather than a sideways scroll.
  const modelColumns: Column<(typeof models)[number]>[] = [
    // SCR-061 (bucket G-3): the id opens the model's detail page.
    {
      key: 'model',
      header: 'Model',
      primary: true,
      cellClassName: 'font-mono text-xs',
      cell: (m) => (
        <Link href={`/agents/models/${encodeURIComponent(m.modelId)}`} className="underline-offset-2 hover:underline">
          {m.modelId}
        </Link>
      ),
    },
    { key: 'provider', header: 'Provider', cell: (m) => m.provider },
    { key: 'status', header: 'Status', badge: true, cell: (m) => <StatusBadge status={m.status} /> },
    { key: 'capabilities', header: 'Capabilities', cellClassName: 'text-muted', cell: (m) => m.capabilities.join(', ') || '—' },
    { key: 'context', header: 'Context', align: 'right', cellClassName: 'tabular', cell: (m) => (m.contextTokens ?? '—').toString() },
    {
      key: 'cost',
      header: '₹ / Mtok in · out',
      align: 'right',
      cellClassName: 'tabular',
      cell: (m) =>
        `${m.inputCostMinorPerMtok !== null ? (m.inputCostMinorPerMtok / 100).toFixed(2) : '—'} · ${m.outputCostMinorPerMtok !== null ? (m.outputCostMinorPerMtok / 100).toFixed(2) : '—'}`,
    },
    // SCR-064 (ADM-84 reversed 2026-09-30): the owner retires a model with a reason.
    ...(isOwner ? [{ key: 'retire', header: 'Retire', cell: (m: (typeof models)[number]) => (m.status === 'retired' ? <span className="text-xs text-muted">retired</span> : <RetireModelForm modelId={m.modelId} />) }] : []),
  ];

  const policyColumns: Column<(typeof policies)[number]>[] = [
    { key: 'category', header: 'Category', primary: true, cell: (p) => p.category.replace('_', ' ') },
    { key: 'optimises', header: 'Optimises for', cell: (p) => p.optimiseFor },
    { key: 'preferred', header: 'Preferred models', cellClassName: 'font-mono text-xs', cell: (p) => p.preferredModels.join(', ') || '—' },
    { key: 'override', header: 'Admin override', cellClassName: 'font-mono text-xs', cell: (p) => p.adminOverrideModel ?? '—' },
    { key: 'configured', header: 'Configured', badge: true, cell: (p) => <Badge tone={p.configured ? 'success' : 'neutral'}>{p.configured ? 'set' : 'resolver default'}</Badge> },
  ];

  const gridColumns: Column<(typeof ai.agents)[number]>[] = [
    {
      key: 'agent',
      header: 'Agent',
      primary: true,
      cell: (a) => {
        const routed = categoryForAgent(a.key);
        return (
          <>
            <Link href={`/agents/${a.key}`} className="font-medium underline-offset-2 hover:underline">
              {a.displayName}
            </Link>
            {routed === null ? <span className="block text-[11px] font-normal text-muted">no category — the runner uses the default</span> : null}
          </>
        );
      },
    },
    { key: 'default', header: 'Default', cellClassName: 'font-mono text-xs text-muted', cell: (a) => a.defaultModel ?? '—' },
    ...ROUTING_CATEGORIES.map(
      (c): Column<(typeof ai.agents)[number]> => ({
        key: c,
        header: c.replace('_', ' '),
        cell: (a) => {
          const routed = categoryForAgent(a.key);
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
            <span className={`flex flex-col gap-0.5 rounded px-1 ${consulted ? 'bg-brand/5' : ''} ${selected ? 'ring-1 ring-inset ring-brand' : ''}`}>
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
          return isOwner ? (
            <Link href={`/agents/routing?agent=${a.key}&category=${c}#override`} scroll={false} className="block rounded hover:bg-surface-2">
              {cell}
            </Link>
          ) : (
            cell
          );
        },
      }),
    ),
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Model routing & providers"
        description="What each category of agent optimises for, and which model it prefers. An admin override wins outright over the resolver's own preference."
        actions={
          <span className="flex items-center gap-4">
            <Link href="/agents/routing-log" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
              Routing log
            </Link>
            <Link href="/agents" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
              Registry &amp; key vault
            </Link>
          </span>
        }
      />

      {/* SCR-064 header: provider status, verified runtime, model availability, routing rules, fallback policy. */}
      <StatGrid>
        <Stat label="Provider Status" value={`${Math.max(ai.providers.length, storedKeys)} of ${VAULT_PROVIDERS.length}`} caption={ai.providerConfigured ? `${ai.providers.join(', ') || 'a stored key'} ready` : 'No provider key — no agent can run'} tone={ai.providerConfigured ? 'success' : 'warning'} icon={<IconAgents size={16} />} href="#vault" />
        <Stat label="Verified Runtime" value={providerVerifiedAt ? 'Verified' : 'Never'} caption={providerVerifiedAt ? `${providerVerifiedAt}${providerVerifiedModel ? ` (${providerVerifiedModel})` : ''}` : 'Configured is not verified'} tone={providerVerifiedAt ? 'success' : 'warning'} icon={<IconSparkle size={16} />} href="#verify" />
        <Stat label="Model Availability" value={`${availableModels.length} available`} caption={`${models.length} registered`} tone={availableModels.length > 0 ? 'success' : 'neutral'} icon={<IconUsage size={16} />} href="#models" />
        <Stat label="Routing Rules" value={`${configuredPolicies} of ${policies.length}`} caption="Categories with a set policy" icon={<IconSettings size={16} />} href="#matrix" />
        <Stat label="Fallback Policy" value={`${chainsSet} of ${chains.length}`} caption="Work classes with a chain" icon={<IconSettings size={16} />} href="#fallback" />
      </StatGrid>

      {/* SCR-064 guardrail: routing authority is the application's, and a gateway is only a provider. */}
      <Callout tone="info" title="The AgencyOS Orchestrator decides the route">
        Which model serves a task is chosen here, by the routing rules and fallback chains below, from the agent and the kind of work. A provider
        only answers: OpenRouter is one of the five providers a model can be served by, a gateway the router may call by model name, and it
        decides nothing about the business workflow.
      </Callout>

      <Card id="verify">
        <CardHeader title="Verify Provider" description="Make one real call to the provider with the model an agent would use. A stored key is configured, not verified, until a call answers." />
        <div className="px-4 pb-4 sm:px-5">
          <VerifyAiProviderForm lastVerifiedAt={providerVerifiedAt} model={providerVerifiedModel} />
        </div>
      </Card>

      <Card id="vault">
        <CardHeader
          title="Providers, keys and models"
          description="Moved: every provider, its keys (several per provider), its models and its health, and the AUTO / MANUAL routing mode, are managed in AI providers."
          actions={
            <Link href="/agents/providers" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
              Open AI providers
            </Link>
          }
        />
        <p className="px-4 pb-4 text-xs text-muted sm:px-5">{storedKeys} of {VAULT_PROVIDERS.length} built-in providers hold a stored key.</p>
      </Card>

      {/* SCR-064 — Decision 2026-09-30: ADM-84 reversed, the owner manages models in the panel. */}
      <Card id="models">
        <CardHeader
          title="Model registry"
          description="ai.models — the models the resolver may name, with their declared capabilities and rates. The owner adds and retires them here; every change is audited."
          actions={<Badge tone={models.some((m) => m.status === 'available') ? 'success' : 'neutral'}>{availableModels.length} available</Badge>}
        />
        {models.length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-muted sm:px-5">
            No model is registered for this organisation yet. Routing falls back to the agent defaults and the free-text preferences below until the
            owner adds one here (ADM-84 reversed 2026-09-30).
          </p>
        ) : (
          <div className="px-4 pb-4 sm:px-5">
            <DataTable dense rows={models} columns={modelColumns} getKey={(m) => `${m.provider}/${m.modelId}`} />
          </div>
        )}
        {isOwner ? <AddModelForm providers={budgets.map((b) => b.provider)} /> : <p className="border-t border-line px-4 py-3 text-xs text-muted sm:px-5">Adding and retiring models is the owner&apos;s alone; shown read-only for your role.</p>}
      </Card>

      <Card id="fallback">
        <CardHeader
          title="Fallback chain per work class"
          description="What the runner tries, in order, for each class of work — after the agent's override and the category policy, before the agent's own default. Only registered, available models may be named."
        />
        <FallbackChainsPanel chains={chains} available={availableModels} editable={isOwner} />
      </Card>

      <Card>
        <CardHeader
          title="Provider budgets"
          description="The most each provider may cost this organisation in a calendar month, against what it has cost so far — from the steps the runtime wrote. Past the cap the runner refuses the call, records the refusal like a policy refusal, and raises a critical alert."
        />
        <ProviderBudgetsPanel budgets={budgets} editable={isOwner} />
      </Card>

      <Card id="model-budgets">
        <CardHeader
          title="Model Budgets"
          description="The most each registered model may cost this organisation in a calendar month, against what it has cost so far. Past the cap the runner refuses calls on that model, records the refusal and raises a critical alert. A provider cap above still applies."
        />
        <ModelBudgetsPanel budgets={modelBudgets} editable={isOwner} />
      </Card>

      <Card id="tool-permissions">
        <CardHeader
          title="Tool Permissions"
          description="Which agents this organisation has allowed or denied on each tool. The owner sets one per agent on the agent's page; open a tool for its calls and failures."
          actions={<Link href="/agents/tools" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">All tools</Link>}
        />
        <ul className="divide-y divide-line">
          {toolPermissions.map(({ tool, permissions }) => (
            <li key={tool.name} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
              <Link href={`/agents/tools/${encodeURIComponent(tool.name)}`} className="underline-offset-2 hover:underline">
                <code className="text-xs">{tool.name}</code>
              </Link>
              <span className="flex items-center gap-2 text-xs text-muted">
                <Badge tone="success">{permissions.filter((p) => p.allowed).length} allowed</Badge>
                <Badge tone={permissions.some((p) => !p.allowed) ? 'danger' : 'neutral'}>{permissions.filter((p) => !p.allowed).length} denied</Badge>
                <span>{tool.boundAgents.length} bound</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card id="matrix">
        <CardHeader
          title="Routing matrix"
          description="Every category and the policy in force. The grid below says which model each agent would actually get."
        />
        <div className="px-4 pb-4 sm:px-5">
          <DataTable dense rows={policies} columns={policyColumns} getKey={(p) => p.category} />
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
        <div className="px-4 pb-4 sm:px-5">
          <DataTable dense rows={ai.agents} columns={gridColumns} getKey={(a) => a.key} />
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
