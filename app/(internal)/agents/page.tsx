import type { Metadata } from 'next';
import Link from 'next/link';

import { formatCostMinor, whyNotRun, wouldRun } from '@/lib/admin/agent-eval';
import { readRunMetrics } from '@/lib/admin/agent-metrics';
import { aiStatus, listHandoffs, listRecentAgentRuns } from '@/lib/admin/agent-status';
import { agencyClock } from '@/lib/admin/agency-clock';
import { readOperationalSettings, settingInstant, settingText } from '@/lib/admin/settings';
import { getAgentUsage } from '@/lib/admin/usage';
import { providerOfModel } from '@/lib/ai/model-provider';
import { providerCredentialStatus } from '@/lib/ai/vault';
import { boundToolKeysFor } from '@/modules/agents/permissions-schema';
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
  IconCheck,
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

  const [{ providerConfigured, providers, agents }, settings, usage, recentRuns, metrics, handoffs] = await Promise.all([
    aiStatus(),
    readOperationalSettings(),
    getAgentUsage(),
    listRecentAgentRuns(8),
    readRunMetrics(),
    listHandoffs(6),
  ]);
  const providerVerifiedAt = settingInstant(settings, 'ai_provider_verified_at');
  const providerVerifiedModel = settingText(settings, 'ai_provider_verified_model');
  const enabledCount = agents.filter((a) => a.enabled).length;
  const runnable = agents.filter((a) => wouldRun(a, providerConfigured)).length;
  const idle = enabledCount - runnable;
  const disabled = agents.length - enabledCount;

  const isAdmin = can(context, 'organization.settings');
  const vaultStatus = isAdmin ? await providerCredentialStatus(await createClient()) : null;
  // SCR-062: the last time a person validated each agent (ai.agent_validations).
  const personValidations = await listLatestAgentValidations();

  const usageByAgent = new Map(usage.perAgent.map((u) => [u.agentKey, u]));
  const nameByKey = new Map(agents.map((a) => [a.key, a.displayName]));
  const topAgents = [...usage.perAgent].sort((a, b) => b.runs - a.runs).slice(0, 5);
  const totalRuns = usage.totals.runs;
  const failedRecent = recentRuns.filter((r) => r.status === 'failed').length;
  const avgSteps = recentRuns.length > 0 ? Math.round(recentRuns.reduce((n, r) => n + r.stepCount, 0) / recentRuns.length) : null;

  const trend = usage.dailyTrend.map((d) => ({ day: clock.date(`${d.day}T12:00:00Z`), runs: d.runs, cost: d.costMinor / 100 }));

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

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="AI Workforce"
        description="Your AI agents, models, tools and automation workflows — what is enforced, and what they actually did. The owner enables or disables an agent and sets its caps on the agent's own page (ADM-82 reversed 2026-09-29); every change is audited."
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
          Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY or OPENROUTER_API_KEY (ADM-85), or store a key in the vault below. Until then no agent can run and nothing is faked.
        </Callout>
      ) : null}

      <StatGrid cols={6}>
        <Stat label="Total agents" value={String(agents.length)} caption={`${enabledCount} enabled`} tone="brand" icon={<IconAgents size={16} />} />
        <Stat label="Would run now" value={String(runnable)} caption={providerConfigured ? `Provider: ${providers.join(', ')}` : 'No provider'} tone={runnable > 0 ? 'success' : 'neutral'} icon={<IconSparkle size={16} />} />
        <Stat label="Runs recorded" value={compact(totalRuns)} caption={usage.capped ? 'Ledger capped' : 'All time'} tone="info" icon={<IconCheck size={16} />} href="/usage" />
        <Stat label="Tokens used" value={compact(usage.totals.inputTokens + usage.totals.outputTokens)} caption={`${compact(usage.totals.inputTokens)} in · ${compact(usage.totals.outputTokens)} out`} tone="accent" icon={<IconUsage size={16} />} href="/usage" />
        <Stat label="AI cost" value={`₹${formatCostMinor(usage.totals.costMinor) ?? '0'}`} caption="From the cost ledger" tone="warning" icon={<IconRupee size={16} />} href="/usage" />
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

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Model usage" description="Runs and cost per model, from the ledger the runtime writes as runs settle." />
          {metrics.byModel.length > 0 ? (
            <ul className="divide-y divide-line">
              {metrics.byModel.map((m) => (
                <li key={m.model} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="flex min-w-0 items-center gap-2">
                    <code className="truncate text-xs">{m.model}</code>
                    <span className="tabular text-muted">{m.runs} run{m.runs === 1 ? '' : 's'}</span>
                  </span>
                  <span className="tabular flex items-center gap-3">
                    <span>₹{formatCostMinor(m.costMinor) ?? '0.00'}</span>
                    <span className="w-10 text-right text-muted">{Math.round(m.share * 100)}%</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No run has settled into the ledger yet.</p>
          )}
        </Card>
        <Card>
          <CardHeader title="Automation" description="The latest agent-to-agent handoffs." actions={<ViewAll href="/agents/automations" label="All handoffs" />} />
          {handoffs.length > 0 ? (
            <ul className="divide-y divide-line">
              {handoffs.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="flex min-w-0 items-center gap-2">
                    <Link href={`/agents/${h.fromAgent}`} className="underline-offset-2 hover:underline">{h.fromAgent}</Link>
                    <span className="text-muted">→</span>
                    <Link href={`/agents/${h.toAgent}`} className="underline-offset-2 hover:underline">{h.toAgent}</Link>
                    <StatusBadge status={h.status} />
                  </span>
                  <span className="text-xs text-muted">{clock.dateTime(h.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No handoff has been recorded yet.</p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Agent activity" description="Runs per day from the cost ledger." />
          <div className="p-4 sm:p-5">
            {trend.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">No runs recorded yet.</p>
            ) : (
              <TrendChart data={trend} xKey="day" series={[{ key: 'runs', label: 'Runs' }]} height={200} />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Agent status" />
          <div className="p-4 sm:p-5">
            {statusData.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">No agents registered.</p>
            ) : (
              <DonutChart data={statusData} colors={['var(--success)', 'var(--warning)', 'var(--faint)']} totalLabel="Total agents" height={150} />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Top agents by usage" actions={<ViewAll href="/usage" />} />
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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(19rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="AI agents" description="The registry, as enforced. Open an agent for its runs and limits." />
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={agents} columns={columns} getKey={(a) => a.key} href={(a) => `/agents/${a.key}`} />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="AI provider"
              actions={<Badge tone={providerConfigured ? 'success' : 'warning'} dot>{providerConfigured ? 'Configured' : 'Not configured'}</Badge>}
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
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <ActivityFeed
            title="Recent agent activity"
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
          <QuickActions
            actions={[
              { label: 'Agent logs', icon: <IconUsage size={13} />, href: '/usage' },
              ...(isAdmin ? [{ label: 'Model routing', icon: <IconSettings size={13} />, href: '/agents/routing' }] : []),
              { label: 'Automations', icon: <IconSparkle size={13} />, href: '/agents/automations' },
              { label: 'Integrations', icon: <IconAgents size={13} />, href: '/integrations' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
