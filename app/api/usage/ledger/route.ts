import { NextResponse } from 'next/server';

import { csvHeaders, toCsv } from '@/lib/admin/csv';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';

/**
 * The cost ledger, row by row — SCR-065's "export cost ledger". One line per
 * `ai.cost_ledger` row (day × agent × model) as `ai.roll_up_run_cost()` wrote
 * it, newest day first, capped at the same 10,000 rows the page reads. The
 * aggregate per-agent file stays at /api/usage/export. Gated on `audit.read`
 * like the page; RLS scopes the ledger to the caller's organisation.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CAP = 10_000;

export async function GET() {
  const context = await requireInternal('/usage');
  if (!can(context, 'audit.read')) {
    return NextResponse.json({ error: 'You do not have permission to read usage.' }, { status: 403 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('ai')
    .from('cost_ledger')
    .select('day, agent_key, model, runs, input_tokens, output_tokens, cost_minor')
    .order('day', { ascending: false })
    .order('agent_key', { ascending: true })
    .limit(CAP);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'usage/ledger', detail: error.message }));
    return NextResponse.json({ error: 'The cost ledger could not be read.' }, { status: 503 });
  }

  const rows = data ?? [];
  const body = toCsv(
    ['day', 'agent_key', 'model', 'runs', 'input_tokens', 'output_tokens', 'cost'],
    [
      ...rows.map((r) => [r.day, r.agent_key, r.model, r.runs, r.input_tokens, r.output_tokens, (Number(r.cost_minor) / 100).toFixed(2)]),
      ...(rows.length >= CAP ? [['NOTE', 'ledger read was capped at 10000 rows; older rows are not included', '', '', '', '', '']] : []),
    ],
  );

  return new NextResponse(body, { status: 200, headers: csvHeaders('ai-cost-ledger.csv') });
}
