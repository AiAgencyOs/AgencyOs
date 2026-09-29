import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { aiStatus, listHandoffs, type AgentRow } from '@/lib/admin/agent-status';
import { readRunMetrics } from '@/lib/admin/agent-metrics';
import { readOperationalSettings, settingInstant, settingText } from '@/lib/admin/settings';
import { providerCredentialStatus } from '@/lib/ai/vault';
import { createClient } from '@/lib/db/server';

import { SetProviderCredentialForm, VerifyAiProviderForm } from '../settings/forms';
import { formatCostMinor, whyNotRun, wouldRun } from '@/lib/admin/agent-eval';
import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  Badge,
  Callout,
  Card,
  CardHeader,
  DataTable,
  IconAlert,
  IconCheck,
  PageHeader,
  Stat,
  StatGrid,
  StatusBadge,
  buttonClass,
  type Column,
} from '@/ui';

export const metadata: Metadata = { title: 'Agents' };

function seconds(value: number | null): string {
  if (value === null) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}

const registryColumns = (clock: AgencyClock, providerConfigured: boolean): Column<AgentRow>[] => [
  {
    key: 'agent',
    header: 'Agent',
    primary: true,
    cell: (a) => (
      <>
        <Link href={`/agents/${a.key}`} className="block font-medium underline-offset-2 hover:underline">
          {a.displayName}
        </Link>
        <code className="block text-xs text-muted">{a.key}</code>
      </>
    ),
  },
  {
    key: 'state',
    header: 'State',
    badge: true,
    cell: (a) => {
      const blocked = whyNotRun(a, providerConfigured);
      return (
        <Badge tone={blocked ? 'neutral' : 'success'} dot>
          {blocked ? `would not run — ${blocked}` : 'would run'}
        </Badge>
      );
    },
  },
  { key: 'autonomy', header: 'Autonomy', cell: (a) => a.autonomyLevel },
  { key: 'model', header: 'Model', cellClassName: 'text-muted', desktopOnly: true, cell: (a) => a.defaultModel ?? '—' },
  { key: 'effort', header: 'Effort', cellClassName: 'text-muted', desktopOnly: true, cell: (a) => a.defaultEffort ?? '—' },
  { key: 'steps', header: 'Max steps', align: 'right', cellClassName: 'tabular', cell: (a) => a.maxSteps ?? '—' },
  {
    key: 'cost',
    header: 'Max cost / run',
    align: 'right',
    cellClassName: 'tabular',
    cell: (a) => {
      const cost = formatCostMinor(a.maxCostMinor);
      return cost ? `₹${cost}` : '—';
    },
  },
  {
    key: 'validated',
    header: 'Validated',
    align: 'right',
    cellClassName: 'text-muted',
    desktopOnly: true,
    cell: (a) => (a.lastValidatedAt ? `${clock.date(a.lastValidatedAt)}${a.definitionVersion ? ` · ${a.definitionVersion}` : ''}` : 'never'),
  },
];

/**
 * The AI agent registry and provider posture — read-only.
 *
 * The audit's clearest safety note lives here: a browser write to `ai.agents`
 * would reopen the cross-tenant break migration `…380000` closed, and agent
 * ACTIVATION is an owner decision withheld by ADM-82. So this page changes
 * nothing. It answers "which agents exist, are they on, what may they do, and
 * would they run right now?" from the enforced state — enabled, autonomy,
 * model, ceilings, last validation — and the single provider boolean, never a
 * key. Gated on `audit.read` (owner + ops_admin), the operational-visibility
 * capability, the same one /operations uses.
 *
 * No "validate configuration" button: the only writer of `last_validated_at`
 * is `stampAgentDefinitions`, a service-role tick in the cron route with no
 * RLS-governed door; a browser control onto it would add a service-role
 * write outside ARCHITECTURE.md §7.3's list. The tick runs on its own and
 * the column shows when it last agreed.
 */
export default async function AgentsPage() {
  const context = await requireInternal('/agents');
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const [{ providerConfigured, providers, agents }, metrics, handoffs, settings] = await Promise.all([
    aiStatus(),
    readRunMetrics(),
    listHandoffs(6),
    readOperationalSettings(),
  ]);
  // G-236: the recorded verification, beside the control that writes it.
  const providerVerifiedAt = settingInstant(settings, 'ai_provider_verified_at');
  const providerVerifiedModel = settingText(settings, 'ai_provider_verified_model');
  const enabledCount = agents.filter((a) => a.enabled).length;
  const runnable = agents.filter((a) => wouldRun(a, providerConfigured)).length;

  // The vault — ADM-84 §9 overturned 2026-09-20. Admin-only, same as the rest
  // of this callout; a non-admin never even asks (RLS would refuse it anyway).
  const isAdmin = can(context.role, 'organization.settings');
  const vaultStatus = isAdmin ? await providerCredentialStatus(await createClient()) : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Agents"
        description="The AI agent registry and provider status, read-only. Enabling an agent or changing its limits is an owner decision made in the database (ADM-82), not from here — this shows what is enforced."
        actions={
          <span className="flex flex-wrap items-center gap-3">
            <Link href="/agents/automations" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
              Automations
            </Link>
            <Link href="/usage" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
              Usage &amp; costs
            </Link>
            <a href="/api/usage/export" className={buttonClass('secondary', 'sm')}>
              Export usage CSV
            </a>
            {isAdmin ? (
              <Link href="/agents/routing" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
                Model routing &amp; providers
              </Link>
            ) : null}
          </span>
        }
      />

      <Callout
        tone={providerConfigured ? 'success' : 'warning'}
        icon={providerConfigured ? <IconCheck size={16} /> : <IconAlert size={16} />}
        title="AI provider"
      >
        {providerConfigured
          ? providerVerifiedAt
            ? `configured (${providers.join(', ')}) and verified — a real call answered ${providerVerifiedAt}${providerVerifiedModel ? ` (${providerVerifiedModel})` : ''}`
            : `configured (${providers.join(', ')}) — registered, and no real call has been recorded yet`
          : 'not configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY or OPENROUTER_API_KEY (ADM-85); until then no agent can run and nothing is faked'}
        {providerConfigured && isAdmin ? (
          <div className="mt-2">
            <VerifyAiProviderForm lastVerifiedAt={providerVerifiedAt} model={providerVerifiedModel} />
          </div>
        ) : null}
      </Callout>

      {isAdmin ? (
        <Card className="flex flex-col gap-2.5 p-4 text-sm sm:p-5">
          <span className="font-semibold">Provider key vault</span>
          <p className="text-xs text-muted">
            A key entered here is encrypted and stored (ADM-84 §9 overturned 2026-09-20); env-set keys still take
            precedence. Once stored, a key is never shown again — only whether it is present and when it was last set.
          </p>
          {vaultStatus?.ok ? (
            <ul className="flex flex-wrap gap-3 text-xs">
              {vaultStatus.data.map((row) => (
                <li key={row.provider} className="flex items-center gap-1">
                  <Badge tone={row.configured ? 'success' : 'neutral'}>{row.provider}</Badge>
                  <span className="text-muted">{row.configured ? `set ${row.updatedAt}` : 'not set'}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <SetProviderCredentialForm />
        </Card>
      ) : null}

      <StatGrid>
        <Stat label="Agents" value={agents.length} caption={`${enabledCount} enabled`} />
        <Stat label="Would run now" value={runnable} tone={runnable > 0 ? 'success' : 'neutral'} />
        <Stat
          label="Average task time"
          value={seconds(metrics.averageSeconds)}
          caption={
            metrics.timedRuns > 0
              ? `median ${seconds(metrics.medianSeconds)} · ${metrics.timedRuns} settled runs${metrics.failedRuns > 0 ? ` · ${metrics.failedRuns} failed` : ''}`
              : 'no settled run has both timestamps yet'
          }
        />
        <Stat
          label="Models used"
          value={metrics.byModel.length}
          caption={metrics.byModel[0] ? `${metrics.byModel[0].model} carries ${Math.round(metrics.byModel[0].share * 100)}% of spend` : 'nothing in the ledger yet'}
        />
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
                    <span className="text-muted tabular">{m.runs} run{m.runs === 1 ? '' : 's'}</span>
                  </span>
                  <span className="flex items-center gap-3 tabular">
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
          <CardHeader
            title="Automation"
            description="The latest agent-to-agent handoffs."
            actions={
              <Link href="/agents/automations" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
                All handoffs
              </Link>
            }
          />
          {handoffs.length > 0 ? (
            <ul className="divide-y divide-line">
              {handoffs.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="flex min-w-0 items-center gap-2">
                    <Link href={`/agents/${h.fromAgent}`} className="underline-offset-2 hover:underline">
                      {h.fromAgent}
                    </Link>
                    <span className="text-muted">→</span>
                    <Link href={`/agents/${h.toAgent}`} className="underline-offset-2 hover:underline">
                      {h.toAgent}
                    </Link>
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

      <DataTable rows={agents} columns={registryColumns(clock, providerConfigured)} getKey={(a) => a.key} />

      {agents.some((a) => !a.enabled && a.disabledReason) ? (
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {agents
            .filter((a) => !a.enabled && a.disabledReason)
            .map((a) => (
              <li key={a.key}>
                <code>{a.key}</code> disabled: {a.disabledReason}
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
