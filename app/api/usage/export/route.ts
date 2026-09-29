import { NextResponse } from 'next/server';

import { csvHeaders, toCsv } from '@/lib/admin/csv';
import { getAgentUsage } from '@/lib/admin/usage';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

/**
 * AI usage as a file — SCR-061. The same aggregation `/usage` renders
 * (`ai.cost_ledger`, per agent), gated on `audit.read` like the page; RLS
 * scopes the ledger to the caller's organization regardless. Cost in
 * major units, tokens as recorded.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await requireInternal('/usage');
  if (!can(context.role, 'audit.read')) {
    return NextResponse.json({ error: 'You do not have permission to read usage.' }, { status: 403 });
  }

  const { perAgent, totals, capped } = await getAgentUsage();

  const body = toCsv(
    ['agent_key', 'runs', 'input_tokens', 'output_tokens', 'cost'],
    [
      ...perAgent.map((a) => [a.agentKey, a.runs, a.inputTokens, a.outputTokens, (a.costMinor / 100).toFixed(2)]),
      ['TOTAL', totals.runs, totals.inputTokens, totals.outputTokens, (totals.costMinor / 100).toFixed(2)],
      ...(capped ? [['NOTE', 'ledger read was capped; older rows are not summed', '', '', '']] : []),
    ],
  );

  return new NextResponse(body, { status: 200, headers: csvHeaders('ai-usage.csv') });
}
