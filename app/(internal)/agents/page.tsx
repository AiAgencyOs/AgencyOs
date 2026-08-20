import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { aiStatus } from '@/lib/admin/agent-status';
import { formatCostMinor, whyNotRun, wouldRun } from '@/lib/admin/agent-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Callout, Card, IconAlert, IconCheck, PageHeader, Stat } from '@/ui';

export const metadata: Metadata = { title: 'Agents' };

const WHEN = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

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
 */
export default async function AgentsPage() {
  const context = await requireInternal('/agents');
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const { providerConfigured, agents } = await aiStatus();
  const enabledCount = agents.filter((a) => a.enabled).length;
  const runnable = agents.filter((a) => wouldRun(a, providerConfigured)).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Agents"
        description="The AI agent registry and provider status, read-only. Enabling an agent or changing its limits is an owner decision made in the database (ADM-82), not from here — this shows what is enforced."
      />

      <Callout
        tone={providerConfigured ? 'success' : 'warning'}
        icon={providerConfigured ? <IconCheck size={16} /> : <IconAlert size={16} />}
        title="AI provider"
      >
        {providerConfigured
          ? 'configured — a generation provider is registered'
          : 'not configured — set ANTHROPIC_API_KEY; until then no agent can run and nothing is faked'}
      </Callout>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Agents" value={agents.length} />
        <Stat label="Enabled" value={enabledCount} />
        <Stat label="Would run now" value={runnable} tone={runnable > 0 ? 'success' : 'neutral'} />
      </div>

      <ul className="flex flex-col gap-3">
        {agents.map((a) => {
          const blocked = whyNotRun(a, providerConfigured);
          const cost = formatCostMinor(a.maxCostMinor);
          return (
            <li key={a.key}>
              <Card className="flex flex-col gap-2.5 p-4 text-sm sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="font-semibold">{a.displayName}</span>
                  <code className="text-xs text-muted">{a.key}</code>
                </div>
                <Badge tone={blocked ? 'neutral' : 'success'} dot>
                  {blocked ? `would not run — ${blocked}` : 'would run'}
                </Badge>
              </div>
              <p className="text-[13px] leading-relaxed text-muted">{a.description}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
                <span>autonomy <span className="text-foreground">{a.autonomyLevel}</span></span>
                <span>model <span className="text-foreground">{a.defaultModel ?? '—'}</span></span>
                <span>effort <span className="text-foreground">{a.defaultEffort ?? '—'}</span></span>
                <span>max steps <span className="text-foreground">{a.maxSteps ?? '—'}</span></span>
                <span>max cost <span className="text-foreground">{cost ? `₹${cost}` : '—'}</span></span>
                <span>
                  validated{' '}
                  <span className="text-foreground">
                    {a.lastValidatedAt ? WHEN.format(new Date(a.lastValidatedAt)) : 'never'}
                    {a.definitionVersion ? ` · ${a.definitionVersion}` : ''}
                  </span>
                </span>
              </div>
              {!a.enabled && a.disabledReason ? (
                <p className="text-xs text-muted">
                  <span className="uppercase tracking-wide">disabled:</span> {a.disabledReason}
                </p>
              ) : null}
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
