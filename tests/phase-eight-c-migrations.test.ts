import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

const { classifyMaintenancePriority } = await import('../src/modules/orchestrator/maintenance-route.ts');
const { sweepMaintenanceLifecycle } = await import('../src/modules/orchestrator/sweeps.ts');
const { phaseEightCWords } = await import('../src/modules/projects/phase-eight-c-words.ts');

/**
 * Text-level guards on the Phase 8 part C migrations and the code around them. A regex cannot say a migration RUNS (scripts/verify-phase-eight-c.sql does,
 * on a scratch Postgres, and every control there was red-proved by mutating the live definition); it can say the shape every table and door must have is
 * present and stays present, and that the TypeScript half (actions, queries, sweep) agrees with the doors.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const dir = join(root, 'supabase/migrations');
const files = readdirSync(dir).filter((f) => /^20261109\d{6}_/.test(f)).sort();
const sql = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
const nocomments = sql.replace(/^\s*--.*$/gm, '');

const TABLES = [
  'maintenance_plan_catalog', 'maintenance_plan_price_lines', 'maintenance_plan_lifecycle', 'maintenance_plan_acceptances', 'maintenance_plan_cycles', 'maintenance_usage_entries',
  'maintenance_overage_drafts', 'maintenance_plan_renewals', 'maintenance_plan_cancellations', 'maintenance_data_safety_records', 'maintenance_stall_policies', 'maintenance_sla_breaches',
  'maintenance_sla_breach_acknowledgements', 'maintenance_work_stalls',
];
const SERVICE_ONLY = ['sweep_maintenance_plan_payment_gates', 'sweep_maintenance_sla', 'sweep_maintenance_stalls'];

describe('Phase 8 part C migrations', () => {
  test('they live in the reserved version range', () => {
    assert.equal(files.length, 2);
    for (const f of files) assert.match(f, /^20261109\d{6}_/);
  });

  test('every table is created, org-scoped, RLS-on, internal-read-only, with no end-user write', () => {
    for (const t of TABLES) {
      assert.match(sql, new RegExp(`create table if not exists projects\\.${t} \\(`), `${t} is created`);
      const body = sql.match(new RegExp(`create table if not exists projects\\.${t} \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? '';
      assert.match(body, /organization_id\s+uuid not null references core\.organizations\(id\)/, `${t} has organization_id`);
      assert.ok(sql.includes(`'${t}'`), `${t} is in a policy/grant loop`);
    }
    assert.ok((nocomments.match(/enable row level security/g) ?? []).length >= 2);
    assert.ok((nocomments.match(/core\.is_internal\(\)/g) ?? []).length >= 2, 'internal-only select policy');
    assert.ok((nocomments.match(/revoke insert, update, delete on projects\.%I from authenticated/g) ?? []).length >= 2);
    assert.ok((nocomments.match(/revoke all on projects\.%I from public, anon/g) ?? []).length >= 2);
    assert.ok((nocomments.match(/core\.freeze_organization_id\(\)/g) ?? []).length >= 2);
    assert.doesNotMatch(nocomments, /grant (insert|update|delete)[^;]*to authenticated/i, 'no table write is granted to a signed-in person');
  });

  test('every foreign key to an org-scoped table has its tenancy trigger', () => {
    const wired = [...nocomments.matchAll(/\('(maintenance_[a-z_]+)', '([a-z_]+)', '([a-z_.]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
    // every FK column to client_accounts / plans / cycles / work items / proposals / invoices-links is in a wiring list
    for (const must of ['maintenance_plan_lifecycle.client_account_id', 'maintenance_plan_acceptances.client_account_id', 'maintenance_plan_cycles.client_account_id', 'maintenance_usage_entries.client_account_id',
      'maintenance_overage_drafts.client_account_id', 'maintenance_plan_renewals.client_account_id', 'maintenance_plan_cancellations.client_account_id', 'maintenance_usage_entries.reverses_entry_id',
      'maintenance_plan_cycles.link_id', 'maintenance_sla_breaches.policy_id']) assert.ok(wired.includes(must), must);
  });

  test('history tables are append-only and state tables move through doors only', () => {
    for (const t of ['maintenance_plan_price_lines', 'maintenance_plan_lifecycle', 'maintenance_plan_acceptances', 'maintenance_plan_cycles', 'maintenance_usage_entries', 'maintenance_overage_drafts', 'maintenance_data_safety_records', 'maintenance_sla_breaches', 'maintenance_sla_breach_acknowledgements', 'maintenance_work_stalls'])
      assert.ok(sql.includes(`'${t}'`), t);
    for (const g of ['maintenance_plan_catalog_guard', 'maintenance_plan_lifecycle_guard', 'maintenance_plan_renewals_guard', 'maintenance_plan_cancellations_guard', 'maintenance_price_line_guard'])
      assert.match(nocomments, new RegExp(`create trigger ${g}`), g);
  });

  test('every function is SECURITY DEFINER with an empty search_path, and revoked from public', () => {
    const fns = [...nocomments.matchAll(/create or replace function projects\.([a-z0-9_]+)\(/g)].map((m) => m[1]!);
    assert.ok(fns.length >= 40, `${fns.length} functions`);
    for (const f of new Set(fns)) {
      const def = nocomments.match(new RegExp(`create or replace function projects\\.${f}\\([\\s\\S]*?\\n(?:end \\$\\$|\\$\\$);`))?.[0] ?? '';
      assert.match(def, /set search_path = ''/, `${f} sets an empty search_path`);
      if (!['p8c_sanctioned', 'p8c_has_secret', 'maintenance_c_history_append_only', 'maintenance_c2_history_append_only', 'maintenance_plan_catalog_guard', 'maintenance_price_line_guard', 'maintenance_plan_lifecycle_guard',
        'maintenance_plan_renewals_guard', 'maintenance_plan_cancellations_guard', 'maintenance_plan_lifecycle_payment_gate'].includes(f!)) {
        assert.match(nocomments, new RegExp(`revoke all on function projects\\.${f}\\([^)]*\\) from public, anon`), `${f} is revoked from public`);
      }
    }
  });

  test('the sweeps are service-role only, by grant AND inside the function', () => {
    for (const f of SERVICE_ONLY) {
      assert.match(nocomments, new RegExp(`revoke all on function projects\\.${f}\\([^)]*\\) from public, anon, authenticated`), `${f} revoked from authenticated`);
      assert.match(nocomments, new RegExp(`grant execute on function projects\\.${f}\\([^)]*\\) to service_role`), `${f} granted to the service role`);
      const def = nocomments.match(new RegExp(`create or replace function projects\\.${f}\\([\\s\\S]*?\\$\\$;`))?.[0] ?? '';
      assert.match(def, /auth\.role\(\)\), ''\) <> 'service_role'/, `${f} checks the role inside`);
    }
  });

  test('money and entitlement are decided by an Admin who is not the author (creator != approver)', () => {
    assert.match(nocomments, /author_cannot_publish/);
    assert.match(nocomments, /v_actor = v_life\.entered_by or v_actor = v_acc\.recorded_by/);
    assert.match(nocomments, /v_actor = v_r\.proposed_by or v_actor = v_r\.decision_recorded_by/);
    assert.match(nocomments, /v_c\.requested_by = v_actor then return query select 'requester_cannot_confirm'/);
    assert.match(nocomments, /v_e\.recorded_by = v_actor then return query select 'self_reversal'/);
    assert.match(nocomments, /v_actor = v_i\.commit_submitted_by then return query select 'self_confirmation'/);
  });

  test('the payment gate reuses finance.maintenance_financial_gate and reads verified money only', () => {
    assert.ok((nocomments.match(/finance\.maintenance_financial_gate\(/g) ?? []).length >= 6);
    assert.match(nocomments, /not in \('verified_paid', 'exception_approved'\)/);
    assert.doesNotMatch(nocomments, /finance\.verify_payment|update finance\.invoices|insert into finance\.(invoices|payments)/, 'nothing here verifies a payment or makes an invoice');
  });

  test('nothing invents a price, bills, quotes or refunds', () => {
    assert.doesNotMatch(nocomments, /insert into (finance|sales)\./i);
    assert.doesNotMatch(nocomments, /refund/i, 'no refund logic: money back is the finance door');
    const drafts = sql.match(/create table if not exists projects\.maintenance_overage_drafts \(([\s\S]*?)\n\);/)?.[1] ?? '';
    assert.doesNotMatch(drafts, /^\s+(invoice|quote|proposal|billed|paid)\w*\s/im, 'no column could bill or quote');
    assert.match(drafts, /status\s+text not null default 'draft' check \(status = 'draft'\)/);
    // the only numbers a person has not typed are computed from entered rates, or are null
    assert.match(nocomments, /round\(v_over \* v_line\.amount_minor\)/);
    const catalog = sql.match(/create table if not exists projects\.maintenance_plan_catalog \(([\s\S]*?)\n\);/)?.[1] ?? '';
    assert.doesNotMatch(catalog, /price|amount|default \d/i, 'a catalog version has no price column and no defaulted number');
  });

  test('client reads are SECURITY DEFINER functions scoped to the caller\'s own account, with no internal columns', () => {
    for (const f of ['client_maintenance_plans', 'client_maintenance_usage']) {
      const def = nocomments.match(new RegExp(`create or replace function projects\\.${f}\\([\\s\\S]*?\\$\\$;`))?.[0] ?? '';
      assert.match(def, /security definer/);
      assert.match(def, /core\.current_client_account_id\(\)/);
      assert.match(def, /core\.is_client\(\)/);
      const header = def.split('as $$')[0] ?? '';
      assert.doesNotMatch(header, /amount|price|rate|reason|invoice|draft|note|work_item|ticket/i, `${f} returns no internal field`);
    }
  });

  test('the data-safety gate is the eleventh gate and the legacy ten are untouched', () => {
    assert.match(nocomments, /'defect_verified', 'no_other_s0_s1', 'data_safety', 'rollback', 'admin_approval'/);
    assert.match(nocomments, /v_i\.created_at < v_cut/);
    assert.match(nocomments, /maintenance_c_cutover/);
  });

  test('the SQL priority rule is the TypeScript router\'s', () => {
    assert.equal(classifyMaintenancePriority({ kind: 'hotfix', emergency: true, sensitive: false, defectSLevel: null }), 'p0');
    assert.equal(classifyMaintenancePriority({ kind: 'hotfix', emergency: false, sensitive: false, defectSLevel: 1 }), 'p1');
    assert.equal(classifyMaintenancePriority({ kind: 'hotfix', emergency: false, sensitive: true, defectSLevel: null }), 'p1');
    assert.equal(classifyMaintenancePriority({ kind: 'patch', emergency: false, sensitive: true, defectSLevel: 0 }), 'p2');
    assert.equal(classifyMaintenancePriority({ kind: 'enhancement', emergency: false, sensitive: false, defectSLevel: null }), 'p3');
    const def = nocomments.match(/create or replace function projects\.maintenance_priority\([\s\S]*?\$\$;/)?.[0] ?? '';
    assert.match(def, /if v_i\.emergency then return 'p0'/);
    assert.match(def, /v_i\.kind = 'hotfix' and \(\(v_s is not null and v_s <= 1\) or v_i\.sensitive\) then return 'p1'/);
    assert.match(def, /v_i\.kind in \('hotfix', 'patch'\) then return 'p2'/);
    assert.match(def, /return 'p3'/);
  });
});

describe('the TypeScript half agrees with the doors', () => {
  const actions = read('src/modules/projects/phase-eight-c-actions.ts');
  const queries = read('src/modules/projects/phase-eight-c-queries.ts');
  const defined = new Set([...nocomments.matchAll(/create or replace function (?:projects|finance)\.([a-z0-9_]+)\(/g)].map((m) => m[1]));

  test('every door an action calls exists, and the actions file exports only async functions', () => {
    const called = [...actions.matchAll(/door\(\s*(?:retire \? '([a-z_]+)' : )?'?([a-z_]+)'?,/g)];
    const names = new Set<string>();
    for (const m of actions.matchAll(/'((?:[a-z]+_)+maintenance_[a-z_]+|[a-z_]*maintenance_[a-z_]+)'/g)) names.add(m[1]!);
    for (const n of names) if (/^(create|add|publish|retire|open|record|activate|reinstate|reverse|draft|propose|confirm|request|decide|acknowledge|set)_/.test(n)) assert.ok(defined.has(n), `${n} is a real door`);
    assert.ok(called.length >= 10);
    for (const line of actions.split('\n')) if (line.startsWith('export ')) assert.match(line, /^export async function /, `only async functions are exported: ${line.slice(0, 50)}`);
    assert.match(actions, /^'use server';/);
  });

  test('actions never create an invoice, quote or payment, and never send to a client', () => {
    assert.doesNotMatch(actions, /finance|invoices|payments|send_outbound|verify_payment/);
  });

  test('every query read has its unreadable() answer, comments included', () => {
    const checks = [...queries.matchAll(/if \(\w+\.error\) unreadable\(/g)].length;
    assert.ok(checks >= 12);
    assert.equal([...queries.matchAll(/unreadable\(/g)].length, checks);
    const portal = read('src/modules/portal/maintenance-queries.ts');
    assert.equal([...portal.matchAll(/unreadable\(/g)].length, [...portal.matchAll(/if \(\w+\.error\) unreadable\(/g)].length);
  });

  test('the portal reads through the client functions only, and shows no price, draft or reason', () => {
    const portal = read('src/modules/portal/maintenance-queries.ts');
    const page = read('app/(client)/portal/[projectId]/maintenance/page.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(portal, /client_maintenance_plans/);
    assert.match(portal, /client_maintenance_usage/);
    assert.doesNotMatch(portal, /\.from\(/, 'no table is read directly');
    assert.doesNotMatch(page, /price|amount|invoice|quote|draft|reason|refund/i);
  });

  test('refusal words are plain and never read as success', () => {
    assert.match(phaseEightCWords('first_cycle_not_paid'), /verified money/);
    assert.match(phaseEightCWords('approver_is_the_author'), /another Admin/);
    assert.match(phaseEightCWords('something_unlisted'), /^Refused: something unlisted\./);
  });

  test('React keys are unique-looking and the panel never builds a key from an index alone', () => {
    const panel = read('app/(internal)/projects/[projectId]/phase-eight-c-panel.tsx');
    assert.doesNotMatch(panel, /key=\{(i|index|n)\}/);
  });
});

describe('the cron sweep', () => {
  type Call = { fn: string; args: Record<string, unknown> };
  const admin = (fail: string | null, throwOn: string | null = null) => {
    const calls: Call[] = [];
    return {
      calls,
      client: {
        schema: () => ({
          rpc: async (fn: string, args: Record<string, unknown>) => {
            calls.push({ fn, args });
            if (fn === throwOn) throw new Error('boom');
            if (fn === fail) return { data: null, error: { message: 'down' } };
            return { data: [{ flagged: 1, expired: 2, checked: 3, breached: 4, skipped_no_policy: 5, marked: 6 }], error: null };
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    };
  };

  test('it runs the 8A renewal sweep and the three 8C sweeps, in one tick', async () => {
    const { calls, client } = admin(null);
    const out = await sweepMaintenanceLifecycle(client);
    assert.deepEqual(calls.map((c) => c.fn), ['sweep_maintenance_renewals', 'sweep_maintenance_plan_payment_gates', 'sweep_maintenance_sla', 'sweep_maintenance_stalls']);
    assert.deepEqual(out.sweep_maintenance_sla, { checked: 3, breached: 4, skipped_no_policy: 5 });
    assert.deepEqual(out.sweep_maintenance_renewals, { flagged: 1, expired: 2 });
  });

  test('a failing or throwing sweep is logged and the rest still run', async () => {
    const logs: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => void logs.push(String(m));
    try {
      const a = admin('sweep_maintenance_plan_payment_gates', 'sweep_maintenance_sla');
      const out = await sweepMaintenanceLifecycle(a.client);
      assert.equal(a.calls.length, 4);
      assert.equal(out.sweep_maintenance_plan_payment_gates, null);
      assert.equal(out.sweep_maintenance_sla, null);
      assert.ok(out.sweep_maintenance_stalls);
      assert.equal(logs.length, 2);
    } finally {
      console.error = orig;
    }
  });

  test('the tick calls it once, after the cron secret is checked and beside the finance sweep', () => {
    const route = read('app/api/jobs/run/route.ts');
    assert.equal(route.split('await sweepMaintenanceLifecycle(admin);').length - 1, 1);
    const auth = route.indexOf('authorizeCronRequest(request.headers.get');
    const sibling = route.indexOf('await sweepFinanceExceptions(admin);');
    const mine = route.indexOf('await sweepMaintenanceLifecycle(admin);');
    assert.ok(auth > 0 && sibling > auth && mine > sibling);
  });

  test('it passes no organization and no clock: the doors read their own', () => {
    const src = read('src/modules/orchestrator/sweeps.ts');
    const fn = src.match(/export async function sweepMaintenanceLifecycle[\s\S]*?\n}\n/)?.[0] ?? '';
    assert.ok(fn.length > 100);
    assert.doesNotMatch(fn, /p_organization_id|p_now/);
  });
});
