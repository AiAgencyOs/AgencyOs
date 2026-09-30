import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { computeMargin, MARGIN_LABEL } from '../src/modules/finance/margin.ts';
import { costOfLog, moneyToMinor, rateInForceOn, setMemberCostRateSchema } from '../src/modules/team/cost-rate-schema.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MIGRATION = read('supabase/migrations/20260930170000_a_person_has_a_cost_rate_with_a_history.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');

/**
 * Bucket E, decision E2 of 2026-09-30: time on the project report is costed
 * at a per-person hourly rate, and A LOG IS PRICED ON ITS DAY — the rate in
 * force for that person on `logged_on`, never today's rate, so a rate change
 * leaves every earlier cost as it was. Rates are cost, not billing.
 *
 * The migration is asserted for the conventions and for the rule's shape
 * (the lateral looks up by logged_on; the table has no update or delete);
 * the arithmetic is pinned through the pure functions the screens and the
 * view agree on; and the places that render a cost are checked to sit
 * behind `invoice.read`.
 */

describe('the migration carries every convention', () => {
  it('core.member_cost_rates has a tenant column, RLS enabled and forced, a select for management only, and a comment', () => {
    assert.match(SQL, /create table if not exists core\.member_cost_rates \([\s\S]{0,400}organization_id\s+uuid not null references core\.organizations\(id\) on delete cascade/);
    assert.match(SQL, /hourly_cost_minor\s+bigint not null check \(hourly_cost_minor > 0\)/);
    assert.match(SQL, /effective_from\s+date not null/);
    assert.match(SQL, /alter table core\.member_cost_rates enable row level security/);
    assert.match(SQL, /alter table core\.member_cost_rates force row level security/);
    assert.match(SQL, /create policy member_cost_rates_select on core\.member_cost_rates[\s\S]{0,200}core\.is_admin\(\)/);
    assert.match(SQL, /comment on table core\.member_cost_rates is/);
    assert.match(SQL, /create trigger freeze_org_member_cost_rates[\s\S]{0,120}core\.freeze_organization_id\(\)/);
  });

  it('the person must be a member of the tenant: core.users is global, so a trigger checks the membership', () => {
    assert.match(SQL, /create trigger member_cost_rates_check_member[\s\S]{0,160}core\.check_cost_rate_member\(\)/);
    assert.match(SQL, /from core\.memberships m[\s\S]{0,200}m\.organization_id = new\.organization_id[\s\S]{0,80}m\.user_id = new\.user_id/);
  });

  it('is append-only: insert is owner only and only through the door; there is no update or delete grant or policy', () => {
    assert.match(SQL, /create policy member_cost_rates_insert on core\.member_cost_rates\s+for insert to authenticated[\s\S]{0,200}core\.is_owner\(\)/);
    assert.doesNotMatch(SQL, /create policy \w+ on core\.member_cost_rates\s+for (update|delete)/);
    assert.match(SQL, /grant select, insert on core\.member_cost_rates to authenticated, service_role/);
    assert.doesNotMatch(SQL, /grant [a-z, ]*(update|delete)[a-z, ]* on core\.member_cost_rates/);
    assert.match(SQL, /revoke update, delete on core\.member_cost_rates from authenticated/);
    // The door marks the transaction; a row without the mark is refused by name.
    assert.match(SQL, /create trigger member_cost_rates_only_through_door\s+before insert on core\.member_cost_rates/);
    assert.match(SQL, /current_setting\('core\.cost_rate_door', true\)/);
    assert.match(SQL, /perform set_config\('core\.cost_rate_door', p_user_id::text, true\)/);
  });

  it('the door is owner-only, security invoker, audited as cost_rate.set with the rate in force as before', () => {
    const fn = SQL.slice(SQL.indexOf('create or replace function core.set_member_cost_rate('), SQL.indexOf('-- ── 3.'));
    assert.match(fn, /security invoker/);
    assert.match(fn, /if not coalesce\(\(select core\.is_owner\(\)\), false\) then/);
    assert.match(fn, /'not_authorized'/);
    assert.match(fn, /'not_a_member'/);
    // BEFORE is the rate that covered the new row's date — looked up by effective_from, not "the latest row".
    assert.match(fn, /select to_jsonb\(c\) into v_before[\s\S]{0,300}c\.effective_from <= p_effective_from[\s\S]{0,120}order by c\.effective_from desc, c\.created_at desc/);
    assert.match(fn, /core\.record_audit\(\s*v_org, 'cost_rate\.set', 'member_cost_rate', v_id, v_before, v_after\s*\)/);
    assert.doesNotMatch(fn, /\bupdate core\.member_cost_rates\b|\bdelete from core\.member_cost_rates\b/);
    assert.match(SQL, /revoke all on function core\.set_member_cost_rate\(uuid, bigint, date, text\) from public, anon/);
    assert.match(SQL, /grant execute on function core\.set_member_cost_rate\(uuid, bigint, date, text\) to authenticated/);
  });

  it('no fail-open guard shape appears', () => {
    assert.doesNotMatch(SQL, /not\s+\(\s*select\s+core\.(?:is_admin|is_owner|can_write|is_internal|can_manage_delivery)\s*\(/);
  });

  it('every dollar-quoted body is closed', () => {
    assert.equal((SQL.match(/\$\$/g) ?? []).length % 2, 0);
  });
});

describe('the view picks the rate by logged_on, not by now()', () => {
  const view = SQL.slice(SQL.indexOf('create or replace view projects.time_log_costs'), SQL.indexOf('-- ── 4.'));

  it('is security_invoker over projects.time_logs with a lateral latest rate on or before the log day', () => {
    assert.match(view, /with \(security_invoker = true\)/);
    assert.match(view, /from projects\.time_logs l/);
    assert.match(view, /left join lateral \([\s\S]{0,400}c\.effective_from <= l\.logged_on[\s\S]{0,120}order by c\.effective_from desc, c\.created_at desc[\s\S]{0,60}limit 1/);
    assert.match(view, /c\.user_id = l\.person_id/);
    assert.match(view, /c\.organization_id = l\.organization_id/);
  });

  it('never consults the clock', () => {
    assert.doesNotMatch(view, /\bnow\(\)|current_date|current_timestamp|localtimestamp/);
  });

  it('prices round(hours × rate) and flags a missing rate rather than pricing it at zero', () => {
    assert.match(view, /round\(l\.hours \* r\.hourly_cost_minor\)::bigint end as cost_minor/);
    assert.match(view, /case when r\.hourly_cost_minor is null then null/);
    assert.match(view, /\(r\.hourly_cost_minor is null\)\s+as rate_missing/);
  });

  it('the three totals views keep their columns in order and append cost_minor and uncosted_hours', () => {
    for (const [name, key] of [['task', 'task_id'], ['project', ''], ['person', 'person_id']] as const) {
      const start = SQL.indexOf(`create or replace view projects.time_log_totals_by_${name}`);
      assert.ok(start >= 0, name);
      const body = SQL.slice(start, SQL.indexOf('group by', start));
      assert.match(body, /with \(security_invoker = true\)/);
      assert.match(body, new RegExp(`select organization_id, project_id${key ? `, ${key}` : ''},\\s+sum\\(hours\\)::numeric\\(10,2\\) as hours,\\s+count\\(\\*\\)::integer\\s+as entries,`));
      assert.match(body, /max\(logged_on\)\s+as last_logged_on,/);
      assert.match(body, /coalesce\(sum\(cost_minor\), 0\)::bigint\s+as cost_minor,/);
      assert.match(body, /coalesce\(sum\(hours\) filter \(where rate_missing\), 0\)::numeric\(10,2\)\s+as uncosted_hours/);
      assert.match(body, /from projects\.time_log_costs/);
      const columns = body.slice(body.indexOf('select'), body.indexOf('from')).match(/as (\w+)/g) ?? [];
      assert.deepEqual(columns.slice(-2), ['as cost_minor', 'as uncosted_hours'], `${name}: the new columns come last`);
    }
  });
});

describe('a log is priced on its day — the arithmetic, in paise', () => {
  const rates = [
    { id: 'a', effectiveFrom: '2026-09-01', createdAt: '2026-09-01T09:00:00Z', hourlyCostMinor: 80_000 },
    { id: 'b', effectiveFrom: '2026-09-29', createdAt: '2026-09-29T09:00:00Z', hourlyCostMinor: 100_000 },
  ];

  it('a rate set from 2026-09-01 prices a log on 2026-09-15 at that rate', () => {
    const r = rateInForceOn(rates.slice(0, 1), '2026-09-15');
    assert.equal(r?.id, 'a');
    assert.equal(costOfLog(1.5, r!.hourlyCostMinor), 120_000);
  });

  it('a new rate from today changes today and later, and leaves the earlier log unchanged', () => {
    assert.equal(rateInForceOn(rates, '2026-09-15')?.id, 'a');
    assert.equal(costOfLog(1.5, rateInForceOn(rates, '2026-09-15')!.hourlyCostMinor), 120_000);
    assert.equal(rateInForceOn(rates, '2026-09-29')?.id, 'b');
    assert.equal(rateInForceOn(rates, '2026-10-02')?.id, 'b');
  });

  it('a log dated before the first rate is uncosted, not zero', () => {
    assert.equal(rateInForceOn(rates, '2026-08-31'), null);
  });

  it('a correction from the same date wins by being newer, so append-only can fix a typo', () => {
    const corrected = [...rates, { id: 'c', effectiveFrom: '2026-09-01', createdAt: '2026-09-02T10:00:00Z', hourlyCostMinor: 85_000 }];
    assert.equal(rateInForceOn(corrected, '2026-09-10')?.id, 'c');
    assert.equal(rateInForceOn(corrected, '2026-09-01')?.id, 'c');
  });

  it('rounds to the paisa, as the view does', () => {
    assert.equal(costOfLog(0.33, 10_001), 3300);
    assert.equal(costOfLog(2.5, 33_333), 83_333);
  });

  it('the form takes rupees and refuses anything that is not a plain amount', () => {
    assert.equal(moneyToMinor('850'), 85_000);
    assert.equal(moneyToMinor('850.5'), 85_050);
    assert.equal(moneyToMinor('850.50'), 85_050);
    assert.equal(moneyToMinor('1,000'), null);
    assert.equal(moneyToMinor('-5'), null);
    assert.equal(moneyToMinor('8.505'), null);
    assert.equal(moneyToMinor(''), null);
  });

  it('the schema refuses a zero rate and a date that is not a day', () => {
    assert.equal(setMemberCostRateSchema.safeParse({ userId: '00000000-0000-4000-8000-000000000000', hourlyCostMinor: 0, effectiveFrom: '2026-09-01' }).success, false);
    assert.equal(setMemberCostRateSchema.safeParse({ userId: '00000000-0000-4000-8000-000000000000', hourlyCostMinor: 85_000, effectiveFrom: 'Sept 1' }).success, false);
    assert.equal(setMemberCostRateSchema.safeParse({ userId: '00000000-0000-4000-8000-000000000000', hourlyCostMinor: 85_000, effectiveFrom: '2026-09-01' }).success, true);
  });
});

describe('the margin subtracts time cost and reports uncosted hours instead of zeroing them', () => {
  it('margin = paid − (expenses + AI cost + time cost)', () => {
    const m = computeMargin({ paidMinor: 1_000_000, expensesMinor: 100_000, aiCostMinor: 50_000, timeCostMinor: 120_000, uncostedHours: 0 });
    assert.equal(m.costMinor, 270_000);
    assert.equal(m.marginMinor, 730_000);
    assert.equal(m.marginPercent, 73);
    assert.equal(m.label, MARGIN_LABEL);
  });

  it('uncosted hours ride along untouched and do not change the sum', () => {
    const m = computeMargin({ paidMinor: 1_000_000, expensesMinor: 100_000, aiCostMinor: 50_000, timeCostMinor: 120_000, uncostedHours: 2.5 });
    assert.equal(m.uncostedHours, 2.5);
    assert.equal(m.marginMinor, 730_000);
  });

  it('the report and both CSVs say "uncosted" rather than hiding those hours', () => {
    const page = read('app/(internal)/projects/[projectId]/reports/page.tsx');
    assert.match(page, /h uncosted — no rate on those days/);
    assert.match(page, /rate on the day of the log/);
    const report = read('app/api/projects/[projectId]/report/route.ts');
    assert.match(report, /'uncosted_hours', margin\.uncostedHours/);
    assert.match(report, /'time_cost', margin\.timeCostMinor/);
    const time = read('app/api/projects/[projectId]/report/time/route.ts');
    assert.match(time, /'cost_minor', 'rate_missing'/);
    assert.match(time, /'cost_minor', 'uncosted_hours'/);
  });
});

describe('a cost renders only where invoice.read holds', () => {
  it('the report gates every cost figure on mayReadMoney, and mayReadMoney is invoice.read', () => {
    const page = stripComments(read('app/(internal)/projects/[projectId]/reports/page.tsx'));
    assert.match(page, /const mayReadMoney = can\(context, 'invoice\.read'\)/);
    // Every line that prints a time cost (the reader's costMinor/uncostedHours,
    // the margin's timeCostMinor) is conditioned on mayReadMoney or reads from
    // `margin`, which exists only for a money reader. The AI-cost sum
    // (`r.costMinor` over agent spend) predates E2 and has its own gate.
    // A guard may open on the line above (a multi-line ternary), so each cost
    // line is judged with the two lines before it.
    const lines = page.split('\n');
    const costLines = lines
      .map((l, i) => [l, i] as const)
      .filter(([l]) => /\b(time|p|t)\.costMinor\b|\btimeCostMinor\b|\buncostedHours\b/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    assert.ok(costLines.length >= 5, `expected several cost renderings, found ${costLines.length}`);
    for (const [line, i] of costLines) {
      const window = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
      assert.ok(/mayReadMoney|margin\b/.test(window), `a cost renders unguarded: ${line.trim()}`);
    }
    // `margin` itself exists only for a money reader.
    assert.match(page, /mayReadMoney \? readProjectMargin\(projectId\) : Promise\.resolve\(null\)/);
  });

  it('the time CSV writes cost columns only for invoice.read', () => {
    const route = stripComments(read('app/api/projects/[projectId]/report/time/route.ts'));
    assert.match(route, /const mayReadMoney = can\(context, 'invoice\.read'\)/);
    assert.match(route, /const costCols = <T,>\(cols: T\[\]\): T\[\] => \(mayReadMoney \? cols : \[\]\)/);
    // The two total lines sit inside one `if (mayReadMoney)` block; every other cost cell goes through costCols.
    assert.match(route, /if \(mayReadMoney\) \{\s*lines\.push\(\['total_cost_minor', time\.costMinor\][^\n]*\n\s*lines\.push\(\['uncosted_hours', time\.uncostedHours\]/);
    const costLines = route.split('\n').filter((l) => /\b(costMinor|uncostedHours|rateMissing)\b/.test(l) && !/total_cost_minor|'uncosted_hours', time/.test(l));
    assert.ok(costLines.length >= 3, `expected several cost cells, found ${costLines.length}`);
    for (const line of costLines) assert.ok(/costCols|mayReadMoney/.test(line), `unguarded: ${line.trim()}`);
  });

  it('the task drawer and the time-log panel never print a cost', () => {
    for (const f of ['app/(internal)/time-log-panel.tsx', 'src/modules/projects/time-log-types.ts']) {
      const src = stripComments(read(f));
      assert.doesNotMatch(src, /costMinor|hourly_cost|rateMissing|time_log_costs/, f);
    }
  });

  it('the Settings › Team cell is rendered only for a role the page admits, and the owner alone sets', () => {
    const page = stripComments(read('app/(internal)/settings/team/page.tsx'));
    assert.match(page, /can\(context, 'organization\.settings'\)\s*\?\s*'set'/);
    assert.match(page, /can\(context, 'audit\.read'\)\s*\?\s*'view'/);
    assert.match(page, /costRateAccess === 'none' \? Promise\.resolve\(\{\}\) : listMemberCostRates\(\)/);
    const panel = stripComments(read('app/(internal)/settings/member-roles-panel.tsx'));
    assert.match(panel, /costRateAccess !== 'none' \? \(\s*<CostRateCell/);
    const cell = stripComments(read('app/(internal)/settings/cost-rate-cell.tsx'));
    assert.match(cell, /access === 'set' && editing \? <SetRateForm/);
    const service = stripComments(read('src/modules/team/cost-rate-service.ts'));
    assert.match(service, /can\(context, 'organization\.settings'\)/);
    assert.match(service, /rpc\('set_member_cost_rate'/);
    assert.doesNotMatch(service, /\.from\('member_cost_rates'\)/, 'the service writes through the door, never the table');
  });
});
