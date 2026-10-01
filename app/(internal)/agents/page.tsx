import type { Metadata } from 'next';
import Link from 'next/link';

import { formatCostMinor, whyNotRun, wouldRun } from '@/lib/admin/agent-eval';
import { readRunMetrics } from '@/lib/admin/agent-metrics';
import { workflowDefinitions } from '@/lib/admin/automation-workflows-eval';
import { aiStatus, listHandoffs, listRecentAgentRuns } from '@/lib/admin/agent-status';
import { getAgentActivity } from '@/lib/admin/dashboard-deltas';
import { periodDelta, trendOf } from '@/lib/admin/period-delta';
import { agencyClock } from '@/lib/admin/agency-clock';
import { readOperationalSettings, settingInstant, settingText } from '@/lib/admin/settings';
import { getAgentUsage } from '@/lib/admin/usage';
import { listModels } from '@/lib/admin/model-registry';
import { providerOfModel } from '@/lib/ai/model-provider';
import { providerCredentialStatus } from '@/lib/ai/vault';
import { AGENT_KEYS } from '@/modules/agents/registry';
import { boundToolKeysFor, listToolDefinitions } from '@/modules/agents/permissions-schema';
import { listLatestAgentValidations } from '@/modules/agents/validation-queries';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import {
  ActivityFeed,
  Avatar,
  Badge,
  buttonClass,
  Callout,
  Card,
  CardHeader,
  DataTable,
  DonutChart,
  IconAgents,
  IconAlert,
  IconClock,
  IconRupee,
  IconSettings,
  IconSparkle,
  IconUsage,
  PageHeader,
  PermissionDenied,
  ProgressBar,
  QuickActions,
  Stat,
  StatGrid,
  StatusBadge,
  TabStrip,
  TrendChart,
  ViewAll,
  humanize,
  type Column,
} from '@/ui';

import { SetProviderCredentialForm, VerifyAiProviderForm } from '../settings/forms';
import { RevokeProviderCredentialForm } from '../settings/revoke-provider-form';

export const metadata: Metadata = { title: 'AI Workforce' };

function seconds(value: number | null): string {
  if (value === null) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}

function compact(n: number): string {
  return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/**
 * The AI Workforce dashboard — the agent registry and provider posture,
 * laid out as the reference's AI screen: six figures, the activity trend,
 * the status donut, top agents by usage, the agent table, and the recent
 * runs feed. Read-only, as before.
 *
 * The audit's clearest safety note lives here: a browser write to `ai.agents`
 * would reopen the cross-tenant break migration `…380000` closed, and agent
 * ACTIVATION is an owner decision withheld by ADM-82. So this page changes
 * nothing. It answers "which agents exist, are they on, what may they do,
 * would they run right now, and what did they actually do?" from the
 * enforced state and the cost ledger — never a key. Gated on `audit.read`.
 */
export default async function AgentsPage() {
  const context = await requireInternal('/agents');
  const clock = await agencyClock();
  if (!can(context, 'audit.read')) return <PermissionDenied />;

  const [{ providerConfigured, providers, agents }, settings, usage, recentRuns, metrics, handoffs, activity, registeredModels] = await Promise.all([
    aiStatus(),
    readOperationalSettings(),
    getAgentUsage(),
    listRecentAgentRuns(8),
    readRunMetrics(),
    listHandoffs(6),
    getAgentActivity(new Date()),
    listModels(),
  ]);
  // A model page exists only for a model the registry holds; a run's model that is not registered is shown as plain text.
  const registeredModelIds = new Set(registeredModels.map((m) => m.modelId));
  const providerVerifiedAt = settingInstant(settings, 'ai_provider_verified_at');
  const providerVerifiedModel = settingText(settings, 'ai_provider_verified_model');
  const enabledCount = agents.filter((a) => a.enabled).length;
  const runnable = agents.filter((a) => wouldRun(a, providerConfigured)).length;
  const idle = enabledCount - runnable;
  const disabled = agents.length - enabledCount;

  const isAdmin = can(context, 'organization.settings');
  const workflowCount = workflowDefinitions(AGENT_KEYS).length;
  const vaultStatus = isAdmin ? await providerCredentialStatus(await createClient()) : null;
  // SCR-062: the last time a person validated each agent (ai.agent_validations).
  const personValidations = await listLatestAgentValidations();

  const usageByAgent = new Map(usage.perAgent.map((u) => [u.agentKey, u]));
  const nameByKey = new Map(agents.map((a) => [a.key, a.displayName]));
  const topAgents = [...usage.perAgent].sort((a, b) => b.runs - a.runs).slice(0, 5);
  const totalRuns = usage.totals.runs;
  const failedRecent = recentRuns.filter((r) => r.status === 'failed').length;
  const avgSteps = recentRuns.length > 0 ? Math.round(recentRuns.reduce((n, r) => n + r.stepCount, 0) / recentRuns.length) : null;

  const trend = usage.dailyTrend.map((d) => ({ day: clock.date(`${d.day}T12:00:00Z`), runs: d.runs, failed: activity.failedByDay[d.day] ?? 0, cost: d.costMinor / 100 }));

  const statusData = [
    { label: 'Would run', value: runnable },
    { label: 'Enabled, blocked', value: idle },
    { label: 'Disabled', value: disabled },
  ].filter((d) => d.value > 0);

  type AgentRow = (typeof agents)[number];
  const columns: Column<AgentRow>[] = [
    {
      key: 'name',
      header: 'Agent',
      primary: true,
      cell: (a) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={a.displayName} size="sm" square />
          <span className="min-w-0">
            <span className="block truncate">{a.displayName}</span>
            <span className="block truncate font-mono text-[10px] font-normal text-muted">{a.key}</span>
          </span>
        </span>
      ),
    },
    { key: 'role', header: 'Role', desktopOnly: true, cellClassName: 'max-w-[18rem] truncate text-muted', cell: (a) => a.description ?? '—' },
    { key: 'model', header: 'Model', desktopOnly: true, cellClassName: 'font-mono text-xs text-muted', cell: (a) => a.defaultModel ?? '—' },
    // SCR-063: the provider that serves the agent's model, by the adapters' own naming rule.
    { key: 'provider', header: 'Provider', desktopOnly: true, cellClassName: 'text-muted', cell: (a) => providerOfModel(a.defaultModel) ?? '—' },
    {
      key: 'status',
      header: 'Status',
      badge: true,
      cell: (a) => {
        const blocked = whyNotRun(a, providerConfigured);
        return <Badge tone={blocked ? (a.enabled ? 'warning' : 'neutral') : 'success'} dot>{blocked ? (a.enabled ? 'Blocked' : 'Disabled') : 'Active'}</Badge>;
      },
    },
    { key: 'autonomy', header: 'Autonomy', desktopOnly: true, cellClassName: 'text-muted', cell: (a) => a.autonomyLevel },
    // SCR-062: the disabled reason as recorded, and what the agent can do — its bound tools and allowed work.
    { key: 'reason', header: 'Disabled reason', desktopOnly: true, cellClassName: 'max-w-[14rem] truncate text-xs text-muted', cell: (a) => (!a.enabled ? (a.disabledReason ?? 'no reason recorded') : '—') },
    {
      key: 'capabilities',
      header: 'Capabilities',
      desktopOnly: true,
      cellClassName: 'text-xs text-muted',
      cell: (a) => {
        const tools = boundToolKeysFor(a.key);
        const work = a.allowedWorkClasses.length === 0 ? 'any work' : a.allowedWorkClasses.map((w) => w.replace('_', ' ')).join(', ');
        return `${tools.length} tool${tools.length === 1 ? '' : 's'} · ${work}`;
      },
    },
    {
      key: 'validated',
      header: 'Validated by a person',
      desktopOnly: true,
      cellClassName: 'text-xs text-muted',
      cell: (a) => {
        const v = personValidations.get(a.key);
        if (!v) return 'never';
        return (
          <span className="flex items-center gap-1.5">
            <Badge tone={v.outcome === 'ok' ? 'success' : 'danger'}>{v.outcome}</Badge>
            <span>{clock.dateTime(v.validatedAt)}{v.validatedByName ? ` · ${v.validatedByName}` : ''}</span>
          </span>
        );
      },
    },
    { key: 'steps', header: 'Max steps', align: 'right', desktopOnly: true, cellClassName: 'tabular text-muted', cell: (a) => (a.maxSteps === null ? '—' : String(a.maxSteps)) },
    { key: 'maxCost', header: 'Max cost', align: 'right', desktopOnly: true, cellClassName: 'tabular text-muted', cell: (a) => { const c = formatCostMinor(a.maxCostMinor); return c ? `₹${c}` : '—'; } },
    { key: 'runs', header: 'Runs', align: 'right', cellClassName: 'tabular', cell: (a) => String(usageByAgent.get(a.key)?.runs ?? 0) },
    { key: 'cost', header: 'Cost', align: 'right', desktopOnly: true, cellClassName: 'tabular text-muted', cell: (a) => { const c = formatCostMinor(usageByAgent.get(a.key)?.costMinor ?? 0); return c ? `₹${c}` : '—'; } },
  ];

  const compactColumns: Column<AgentRow>[] = [
    { key: 'n', header: '#', desktopOnly: true, cellClassName: 'tabular text-muted', cell: (a) => agents.indexOf(a) + 1 },
    {
      key: 'name',
      header: 'Agent Name',
      primary: true,
      cell: (a) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={a.displayName} size="sm" square />
          <span className="block truncate">{a.displayName}</span>
        </span>
      ),
    },
    { key: 'role', header: 'Role', desktopOnly: true, cellClassName: 'max-w-[14rem] truncate text-muted', cell: (a) => a.description ?? '—' },
    { key: 'model', header: 'Model', desktopOnly: true, cellClassName: 'whitespace-nowrap text-xs text-muted', cell: (a) => a.defaultModel ?? '—' },
    {
      key: 'status',
      header: 'Status',
      badge: true,
      cell: (a) => {
        const blocked = whyNotRun(a, providerConfigured);
        return <Badge tone={blocked ? (a.enabled ? 'warning' : 'neutral') : 'success'} dot>{blocked ? (a.enabled ? 'Blocked' : 'Disabled') : 'Active'}</Badge>;
      },
    },
    { key: 'runs', header: 'Tasks', align: 'right', cellClassName: 'tabular', cell: (a) => String(usageByAgent.get(a.key)?.runs ?? 0) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="AI Workforce"
        description="Manage your AI agents, models, tools and automation workflows."
        actions={
          <>
            <Link href="/usage" className={buttonClass('secondary', 'sm')}>
              <IconUsage size={14} />
              Agent logs
            </Link>
            <a href="/api/usage/export" className={buttonClass('secondary', 'sm')}>
              Export usage CSV
            </a>
            {isAdmin ? (
              <Link href="/agents/routing" className={buttonClass('secondary', 'sm')}>
                <IconSettings size={14} />
                Model routing
              </Link>
            ) : null}
            <Link href="/agents/automations" className={buttonClass('primary', 'sm')}>
              <IconSparkle size={14} />
              Automations
            </Link>
          </>
        }
      />

      {!providerConfigured ? (
        <Callout tone="warning" icon={<IconAlert size={16} />} title="AI provider not configured">
          Add ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY or OPENROUTER_API_KEY (ADM-85) under <Link href="/security/keys" className="underline underline-offset-2">Governance &amp; Security › Keys &amp; secrets</Link> (or set it in the deployment environment), or store a key in the vault below. Until then no agent can run and nothing is faked.
        </Callout>
      ) : null}
      <StatGrid cols={5}>
        <Stat label="Total Agents" value={String(agents.length)} caption={`${enabledCount} enabled · ${runnable} would run`} tone="brand" icon={<IconAgents size={16} />} />
        <Stat label="Total Tasks Executed" value={compact(totalRuns)} caption={usage.capped ? 'Ledger capped' : 'All time'} trend={trendOf(periodDelta(activity.runs))} tone="accent" icon={<IconSparkle size={16} />} href="/usage" />
        <Stat label="Total Tokens Used" value={compact(usage.totals.inputTokens + usage.totals.outputTokens)} caption={`${compact(usage.totals.inputTokens)} in · ${compact(usage.totals.outputTokens)} out`} trend={trendOf(periodDelta(activity.tokens))} tone="info" icon={<IconUsage size={16} />} href="/usage" />
        <Stat label="AI Cost" value={`₹${formatCostMinor(usage.totals.costMinor) ?? '0'}`} caption="From the cost ledger" trend={trendOf(periodDelta(activity.cost), true)} tone="danger" icon={<IconRupee size={16} />} href="/usage" />
        <Stat label="Avg. Task Time" value={seconds(metrics.averageSeconds)} caption={metrics.timedRuns > 0 ? `Median ${seconds(metrics.medianSeconds)} · ${metrics.timedRuns} settled runs` : 'No settled run yet'} tone="info" icon={<IconClock size={16} />} />
      </StatGrid>

      <TabStrip
        label="AI Workforce"
        tabs={[
          { href: '/agents', label: 'Overview', icon: <IconAgents size={15} />, exact: true },
          { href: '/agents#agents', label: 'Agents', icon: <IconAgents size={15} /> },
          { href: '/usage/runs', label: 'Task Runs', icon: <IconSparkle size={15} /> },
          { href: '/usage', label: 'Model Usage', icon: <IconUsage size={15} /> },
          { href: '/agents/tools', label: 'Tools & Integrations', icon: <IconSettings size={15} /> },
          { href: '/agents/automations', label: 'Automations', icon: <IconSparkle size={15} /> },
          ...(isAdmin ? [{ href: '/agents/routing', label: 'Settings', icon: <IconSettings size={15} /> }] : []),
        ]}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Agent Activity" />
          <div className="p-4 sm:p-5">
            {trend.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">No runs recorded yet.</p>
            ) : (
              <TrendChart data={trend} xKey="day" series={[{ key: 'runs', label: 'Runs' }, { key: 'failed', label: 'Failed', color: 'var(--danger)' }]} height={200} />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Agent Status" />
          <div className="p-4 sm:p-5">
            {statusData.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">No agents registered.</p>
            ) : (
              <DonutChart data={statusData} colors={['var(--success)', 'var(--warning)', 'var(--faint)']} totalLabel="Total agents" height={150} />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Top Agents by Usage" actions={<ViewAll href="/usage" />} />
          {topAgents.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted sm:px-5">No runs recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-3 p-4 sm:p-5">
              {topAgents.map((u) => (
                <li key={u.agentKey} className="flex items-center gap-3">
                  <Avatar name={nameByKey.get(u.agentKey) ?? u.agentKey} size="md" square />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <Link href={`/agents/${u.agentKey}`} className="truncate text-[13px] font-medium text-foreground hover:text-brand">
                        {nameByKey.get(u.agentKey) ?? u.agentKey}
                      </Link>
                      <span className="tabular shrink-0 text-xs text-muted">{u.runs} runs</span>
                    </span>
                    <ProgressBar value={totalRuns > 0 ? (u.runs / totalRuns) * 100 : 0} tone="brand" size="sm" label={`${nameByKey.get(u.agentKey) ?? u.agentKey} share of runs`} className="mt-1 w-full" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(19rem,1fr)]">
        <Card id="agents">
          <CardHeader title="AI Agents" actions={<ViewAll href="/agents/routing" />} />
          <div className="px-4 pb-4 sm:px-5">
            <DataTable dense rows={agents} columns={compactColumns} getKey={(a) => a.key} rowActions={(a) => [{ key: 'open', label: 'Open agent', href: `/agents/${a.key}` }]} />
          </div>
        </Card>
          <ActivityFeed
            title="Recent Agent Activity"
            viewAllHref="/usage"
            emptyTitle="No runs yet"
            emptyDescription="Every run an agent makes is recorded here, with its outcome."
            compact
            items={recentRuns.map((r) => ({
              id: r.id,
              title: `${nameByKey.get(r.agentKey) ?? r.agentKey} · ${humanize(r.trigger)}`,
              detail: r.error ? r.error : `${r.stepCount} step${r.stepCount === 1 ? '' : 's'}${r.model ? ` · ${r.model}` : ''}${r.subjectType ? ` · ${humanize(r.subjectType)}` : ''}`,
              when: clock.dateTime(r.createdAt),
              tone: r.status === 'failed' ? 'danger' : r.status === 'succeeded' || r.status === 'completed' ? 'success' : 'info',
              icon: r.status === 'failed' ? <IconAlert size={13} /> : <IconSparkle size={13} />,
              href: `/agents/${r.agentKey}`,
            }))}
          />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Model Usage" actions={<ViewAll href="/usage" />} />
          {metrics.byModel.length > 0 ? (
            <ul className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              {metrics.byModel.slice(0, 5).map((m) => (
                <li key={m.model} className="grid grid-cols-[minmax(0,8rem)_1fr_2.5rem] items-center gap-3 text-[13px]">
                  {registeredModelIds.has(m.model) ? (
                    <Link href={`/agents/models/${encodeURIComponent(m.model)}`} className="truncate font-medium hover:text-brand">{m.model}</Link>
                  ) : (
                    <span className="truncate font-medium" title="Not in the model registry">{m.model}</span>
                  )}
                  <ProgressBar value={m.share * 100} showValue={false} tone="brand" size="sm" label={`${m.model} share of spend`} className="w-full" />
                  <span className="tabular text-right text-muted">{Math.round(m.share * 100)}%</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No run has settled into the ledger yet.</p>
          )}
        </Card>
        <Card>
          <CardHeader title="Automation Workflows" description={`${workflowCount} defined in code; handoffs below`} actions={<ViewAll href="/agents/automations" />} />
          {handoffs.length > 0 ? (
            <ul className="divide-y divide-line">
              {handoffs.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="flex min-w-0 items-center gap-2">
                    <Link href={`/agents/${h.fromAgent}`} className="underline-offset-2 hover:underline">{h.fromAgent}</Link>
                    <span className="text-muted">→</span>
                    <Link href={`/agents/${h.toAgent}`} className="underline-offset-2 hover:underline">{h.toAgent}</Link>
                  </span>
                  <StatusBadge status={h.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No handoff has been recorded yet.</p>
          )}
        </Card>
        <QuickActions
          actions={[
            { label: 'View Logs', icon: <IconUsage size={13} />, href: '/usage' },
            ...(isAdmin ? [{ label: 'Configure Model', icon: <IconSettings size={13} />, href: '/agents/routing' }] : []),
            { label: 'View Automations', icon: <IconSparkle size={13} />, href: '/agents/automations' },
            { label: 'Integrations', icon: <IconAgents size={13} />, href: '/integrations' },
          ]}
        />
      </div>

      <h2 className="mt-2 text-base font-bold tracking-tight text-foreground">Governance and detail</h2>
      <StatGrid cols={4}>
        <Stat label="Would run now" value={String(runnable)} caption={providerConfigured ? `Provider: ${providers.join(', ')}` : 'No provider'} tone={runnable > 0 ? 'success' : 'neutral'} icon={<IconSparkle size={16} />} />
        <Stat label="Recent failures" value={String(failedRecent)} caption={avgSteps === null ? 'No runs yet' : `avg ${avgSteps} steps · last ${recentRuns.length}`} tone={failedRecent > 0 ? 'danger' : 'neutral'} icon={<IconClock size={16} />} />
      </StatGrid>

      {/*
        SCR-061: how long a task takes and where the model spend goes, from
        rows the runtime wrote (`agent_runs.started_at/finished_at`, the cost
        ledger per model). Nothing estimated; "—" when nothing has settled.
      */}
      <StatGrid cols={4}>
        <Stat
          label="Average task time"
          value={seconds(metrics.averageSeconds)}
          caption={metrics.timedRuns > 0 ? `Median ${seconds(metrics.medianSeconds)} · ${metrics.timedRuns} settled runs` : 'No settled run has both timestamps yet'}
          tone="info"
          icon={<IconClock size={16} />}
        />
        <Stat
          label="Models used"
          value={String(metrics.byModel.length)}
          caption={metrics.byModel[0] ? `${metrics.byModel[0].model} carries ${Math.round(metrics.byModel[0].share * 100)}% of spend` : 'Nothing in the ledger yet'}
          tone="accent"
          icon={<IconSparkle size={16} />}
        />
        <Stat label="Handoffs" value={String(handoffs.length)} caption="Most recent agent-to-agent handoffs" tone="brand" icon={<IconAgents size={16} />} href="/agents/automations" />
        <Stat label="Failed (sample)" value={String(metrics.failedRuns)} caption={`Of the last ${metrics.timedRuns || 0} settled runs`} tone={metrics.failedRuns > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} />
      </StatGrid>

      {/* SCR-061 (bucket G-3): the tools, each opening its detail — what it
          does, who is bound to it, how often it was called and failed. */}
      <Card>
        <CardHeader title="Tools" description="Every tool an agent can be bound to, from the registry in code. Open one for its calls, failures and per-agent permissions." />
        <ul className="divide-y divide-line">
          {listToolDefinitions().map((t) => (
            <li key={t.name} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
              <span className="flex min-w-0 items-center gap-2">
                <Link href={`/agents/tools/${encodeURIComponent(t.name)}`} className="min-w-0 underline-offset-2 hover:underline">
                  <code className="truncate text-xs">{t.name}</code>
                </Link>
                <Badge tone={t.actionClass === 'L0' ? 'success' : t.actionClass === 'L1' ? 'info' : 'warning'}>{t.actionClass}</Badge>
              </span>
              <span className="flex min-w-0 items-center gap-3 text-muted">
                <span className="hidden truncate sm:inline">{t.purpose}</span>
                <span className="tabular shrink-0">
                  {t.boundAgents.length} agent{t.boundAgents.length === 1 ? '' : 's'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {/* The registry in full — every governance column the compact table above leaves out. */}
      <Card>
            <CardHeader title="Agent registry" description="As enforced — autonomy, caps, validation and capabilities. Open an agent for its runs and limits. Admin and Client are people, and WhatsApp is a channel the agents use as a tool, so none of the three is an agent here." />
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={agents} columns={columns} getKey={(a) => a.key} href={(a) => `/agents/${a.key}`} />
            </div>
          </Card>

      <Card>
            <CardHeader
              title="AI provider"
              actions={
                <span className="flex items-center gap-2">
                  <Badge tone={providerConfigured ? 'success' : 'warning'} dot>{providerConfigured ? 'Configured' : 'Not configured'}</Badge>
                  {providerConfigured ? null : <Link href="/security/keys#ai" className="text-xs underline underline-offset-2">Add a key</Link>}
                </span>
              }
              description={
                providerConfigured
                  ? providerVerifiedAt
                    ? `${providers.join(', ')} — verified: a real call answered ${providerVerifiedAt}${providerVerifiedModel ? ` (${providerVerifiedModel})` : ''}.`
                    : `${providers.join(', ')} — registered; no real call has been recorded yet.`
                  : 'No provider key is registered.'
              }
            />
            {providerConfigured && isAdmin ? (
              <div className="px-4 pb-4 sm:px-5">
                <VerifyAiProviderForm lastVerifiedAt={providerVerifiedAt} model={providerVerifiedModel} />
              </div>
            ) : null}
            {isAdmin ? (
              <div id="vault" className="flex flex-col gap-2.5 border-t border-line px-4 py-4 text-sm sm:px-5">
                <span className="font-semibold">Provider key vault</span>
                <p className="text-xs text-muted">
                  A key entered here is encrypted and stored (ADM-84 §9 overturned 2026-09-20); env-set keys still take precedence. Once stored, a key is never shown again — only whether it is present and when it was last set.
                </p>
                {vaultStatus?.ok ? (
                  <ul className="flex flex-wrap gap-3 text-xs">
                    {vaultStatus.data.map((row) => (
                      <li key={row.provider} className="flex flex-wrap items-center gap-1">
                        <Badge tone={row.configured ? 'success' : 'neutral'}>{row.provider}</Badge>
                        <span className="text-muted">{row.configured ? `set ${row.updatedAt}` : 'not set'}</span>
                        {row.configured && hasRole(context, 'owner') ? <RevokeProviderCredentialForm provider={row.provider} /> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <SetProviderCredentialForm />
              </div>
            ) : null}
          </Card>
      <Card>
            <CardHeader title="Run outcomes" description="The last few runs, by status." />
            <ul className="flex flex-wrap gap-2 px-4 pb-4 sm:px-5">
              {[...new Set(recentRuns.map((r) => r.status))].map((s) => (
                <li key={s}>
                  <StatusBadge status={s} />
                  <span className="ml-1 text-xs text-muted">{recentRuns.filter((r) => r.status === s).length}</span>
                </li>
              ))}
              {recentRuns.length === 0 ? <li className="text-[13px] text-muted">Nothing recorded.</li> : null}
            </ul>
          </Card>
    </div>
  );
}
