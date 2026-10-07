import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

const { parseCoverage, parseDefinitionOfDone, parseHandoff } = await import('../src/modules/projects/functional-test-parse.ts');
const { parseExceptionStates, parseFutureWork, parseHealth } = await import('../src/modules/projects/phase-seven-gaps-parse.ts');
const { outcomeWords } = await import('../src/modules/projects/maintenance-engineering.ts');

/**
 * Phases 5/6/7 gap closure. The database rules are PROVEN by scripts/verify-phase-567-gaps.sql on a scratch Postgres (each control red-proved by mutating
 * the live definition). This file guards what a regex honestly can: the shape of the migrations (tenancy guards, RLS, doors revoked from public) and
 * that the TypeScript half reads the doors' answers without upgrading them: an unknown recommendation is never a pass.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const dir = join(root, 'supabase/migrations');
const files = readdirSync(dir).filter((f) => /^20261123\d{6}_/.test(f)).sort();
const sql = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
const nocomments = sql.replace(/^\s*--.*$/gm, '');

describe('the gap-closure migrations', () => {
  test('use only the allotted timestamp range', () => {
    assert.ok(files.length >= 3);
    for (const f of files) assert.match(f, /^20261123\d{6}_/);
  });

  test('every new table is internal-only, tenancy-guarded and not writable by a signed-in person', () => {
    const tables = [...nocomments.matchAll(/create table if not exists (?:qa|projects)\.(\w+)/g)].map((m) => m[1]);
    assert.ok(tables.length >= 5, `expected the new tables, found ${tables.length}`);
    for (const t of tables) {
      assert.ok(nocomments.includes(`'${t}'`), `${t} is listed in a tenancy / RLS loop`);
    }
    assert.match(nocomments, /enable row level security/);
    assert.match(nocomments, /core\.enforce_parent_org/);
    assert.match(nocomments, /core\.freeze_organization_id/);
    assert.match(nocomments, /revoke insert, update, delete on/);
    assert.match(nocomments, /core\.is_internal\(\)/);
  });

  test('every door is revoked from public and granted explicitly', () => {
    const doors = [...nocomments.matchAll(/create or replace function ((?:qa|projects|finance)\.\w+)\(([^)]*)\)/g)].map((m) => ({ name: m[1], args: m[2] }));
    const skipped = new Set(['qa.functional_scenario_kinds', 'qa.functional_case_profiles_guard', 'projects.maintenance_work_flags_are_monotonic', 'projects.p7_suggest_feedback_classification']);
    for (const d of doors) {
      const name = d.name ?? '';
      if (skipped.has(name)) continue;
      assert.match(nocomments, new RegExp(`revoke all on function ${name.replace('.', '\\.')}\\([^)]*\\) from public, anon`), `${name} is revoked from public`);
    }
  });

  test('no door takes an amount and none sends, deploys or approves', () => {
    for (const forbidden of ['verify_payment', 'create_composed_invoice', 'issue_invoice', 'emit_event']) assert.ok(!nocomments.includes(forbidden), forbidden);
    assert.ok(!/p_amount|p_total/.test(nocomments), 'no amount parameter');
  });

  test('the data-safety gate is keyed on the area, and the flag and area are monotonic', () => {
    assert.match(nocomments, /if v_i\.area is distinct from ''database'' or v_cut is null or v_i\.created_at < v_cut then/);
    assert.match(nocomments, /old\.sensitive and not new\.sensitive/);
    assert.match(nocomments, /old\.area = 'database' and new\.area is distinct from 'database'/);
  });

  test('a maintenance invoice binds to the accepted price and to a bounded cycle', () => {
    for (const outcome of ['no_accepted_price', 'amount_differs_from_the_accepted_price', 'cycle_too_long', 'cycle_overlaps_a_billed_cycle', 'cycle_outside_the_plan_period', 'cycle_is_not_the_accepted_renewal']) {
      assert.ok(nocomments.includes(`'${outcome}'`), outcome);
      assert.ok(!outcomeWords(outcome).startsWith('Refused:'), `${outcome} has words`);
    }
    // no price is typed: the proposal is read, never written
    assert.ok(!/update sales\.proposals|insert into sales\.proposals/.test(nocomments));
  });

  test('the P604 handoff can never declare production readiness', () => {
    assert.match(nocomments, /'declares_production_ready', false/);
    assert.ok(!/'declares_production_ready', true/.test(nocomments));
    assert.ok(!/production_ready_recommended|ready_for_production/.test(nocomments));
  });

  test('NOT_APPLICABLE is not a fifth case status', () => {
    assert.ok(!/alter table qa\.phase6_cases/.test(nocomments));
    assert.match(nocomments, /a_tested_case_is_applicable/);
  });
});

describe('the TypeScript half reads the doors without upgrading them', () => {
  test('an unknown handoff recommendation is read as incomplete, never as a pass', () => {
    const h = parseHandoff({ planId: 'p', build: { commit: 'abc' }, recommendation: 'ship_it', definitionOfDone: [], requirements: {}, totals: {} });
    assert.equal(h?.recommendation, 'incomplete');
    assert.equal(h?.declaresProductionReady, false);
  });
  test('a handoff that says it is production-ready is still read as not production-ready', () => {
    const h = parseHandoff({ planId: 'p', build: {}, recommendation: 'functional_pass_recommended', declares_production_ready: true });
    assert.equal(h?.declaresProductionReady, false);
    assert.equal(parseHandoff(null), null);
  });
  test('an unknown coverage value is uncovered, never covered', () => {
    const rows = parseCoverage([{ scope_item_id: 's', title: 't', direct_cases: 1, kinds_covered: ['happy_path'], kinds_missing: [], excluded_reason: null, coverage: 'mystery' }]);
    assert.equal(rows[0]?.coverage, 'uncovered');
  });
  test('definition-of-done rows are satisfied only when the database says true', () => {
    const rows = parseDefinitionOfDone([{ item: 'a', satisfied: true, detail: 'x' }, { item: 'b', satisfied: 'true', detail: 'y' }, { item: 'c', satisfied: null, detail: null }]);
    assert.deepEqual(rows.map((r: { satisfied: boolean }) => r.satisfied), [true, false, false]);
  });
  test('exception states outside the three are dropped, and a health snapshot is always a manual note', () => {
    assert.equal(parseExceptionStates([{ state: 'handover_blocked', reason: 'r', source: 's' }, { state: 'made_up', reason: 'r', source: 's' }]).length, 1);
    assert.equal(parseHealth([{ snapshot_id: 'h', status: 'healthy', source: 'manual', recorded_at: 'now', age_minutes: 3 }])?.monitoringSourceConfigured, false);
    assert.equal(parseHealth([]), null);
    assert.equal(parseFutureWork([{ kind: 'k', ref_id: 'r', summary: 's', route: null, source: 'x' }])[0]?.route, null);
  });
});

describe('the new modules follow the house rules', () => {
  const queries = ['src/modules/projects/functional-test-queries.ts', 'src/modules/projects/phase-seven-gaps-queries.ts'];
  test('every read checks its error and surfaces it (count of error checks equals count of unreadable calls, comments included)', () => {
    for (const f of queries) {
      const s = read(f);
      const checks = (s.match(/if \(\w+\.error\)/g) ?? []).length;
      const unread = (s.match(/unreadable\(/g) ?? []).length;
      assert.equal(checks, unread - 0, f);
      assert.ok(checks > 0, f);
    }
  });
  test("'use server' files export only async functions", () => {
    for (const f of ['src/modules/projects/functional-test-actions.ts', 'src/modules/projects/phase-seven-gaps-actions.ts']) {
      const s = read(f);
      assert.ok(s.startsWith("'use server'"), f);
      const exports = [...s.matchAll(/^export (\w+)/gm)].map((m) => m[1]);
      assert.ok(exports.length > 0);
      for (const e of exports) assert.equal(e, 'async', `${f} exports a non-async ${e}`);
    }
  });
  test('the actions never write a table or call a forbidden door directly', () => {
    for (const f of ['src/modules/projects/functional-test-actions.ts', 'src/modules/projects/phase-seven-gaps-actions.ts']) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const bad of ['.insert(', '.update(', '.delete(', '.upsert(', 'sendMessage', 'verify_payment']) assert.ok(!code.includes(bad), `${f} uses ${bad}`);
    }
  });
});
