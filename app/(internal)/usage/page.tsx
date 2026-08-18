import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { formatCostMinor } from '@/lib/admin/agent-eval';
import { getAgentUsage } from '@/lib/admin/usage';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

export const metadata: Metadata = { title: 'Usage & costs · AgencyOS' };

/**
 * AI usage & cost — what the agents actually consumed, from `ai.agent_runs`
 * (tokens) and `ai.agent_steps` (cost). Every figure is recorded, not estimated;
 * there is no rate card and no invented number. When nothing has run the page
 * says so rather than showing zeros dressed as insight. Gated on `audit.read`
 * (owner + ops_admin), like the Agents page.
 */

const N = new Intl.NumberFormat('en-IN');

export default async function UsagePage() {
  const context = await requireInternal('/usage');
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const { perAgent, totals, capped } = await getAgentUsage();
  const cost = (minor: number) => `₹${formatCostMinor(minor) ?? '0.00'}`;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Usage &amp; costs</h1>
        <p className="text-sm text-muted">
          What the AI agents actually consumed — recorded per run and per step, never estimated. Cost is what the
          runtime wrote down; there is no rate card here.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Agent runs', N.format(totals.runs)],
          ['Input tokens', N.format(totals.inputTokens)],
          ['Output tokens', N.format(totals.outputTokens)],
          ['Cost', cost(totals.costMinor)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/15">
            <div className="text-lg font-semibold tabular-nums">{value}</div>
            <div className="text-xs text-muted">{label}</div>
          </div>
        ))}
      </div>

      {perAgent.length === 0 ? (
        <p className="rounded-lg border border-black/10 px-4 py-8 text-center text-sm text-muted dark:border-white/15">
          No agent usage has been recorded yet. Agents run only when enabled and a provider is configured — usage and
          cost appear here once they do.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-xs text-muted dark:border-white/15">
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 text-right font-medium">Runs</th>
                <th className="px-4 py-2 text-right font-medium">Input tokens</th>
                <th className="px-4 py-2 text-right font-medium">Output tokens</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {perAgent.map((a) => (
                <tr key={a.agentKey} className="border-b border-black/5 last:border-0 dark:border-white/5">
                  <td className="px-4 py-2 font-medium">{a.agentKey}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{N.format(a.runs)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{N.format(a.inputTokens)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{N.format(a.outputTokens)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{cost(a.costMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted">
        Scoped to your organization (RLS). {capped ? 'Showing the most recent records (capped); older usage is not summed here. ' : ''}
        Cost is the sum of what each step recorded — an empty table means nothing has run, not that it was free.
      </p>
    </div>
  );
}
