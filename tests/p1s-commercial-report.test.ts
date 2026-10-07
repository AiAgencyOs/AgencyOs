import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { closeRate, parseCommercialReport, REPORT_WINDOWS } from '../src/modules/sales/p1s-commercial-model.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const migration = read('supabase/migrations/20261204400000_p1s_the_commercial_report_reads_what_the_deals_discounts_objections_and_agents_already_record.sql');

/**
 * P1-CRM-045 / P1-CRM-063: the commercial report is a read of existing rows, parsed defensively, and a rate is null (printed "no deals") when nothing closed.
 */

const sample = {
  days: 90,
  deals: { won: 3, lost: 2, wonValueMinor: 600000, avgWonValueMinor: 200000 },
  discount: { decisions: { autonomous: 1, approved: '1', pending_approval: 1 }, takenEffectMinor: 15000, avgPct: 9.1, discountedWon: 1, discountedLost: 1, plainWon: 2, plainLost: 1 },
  trustOffer: { won: 1, lost: 0, standardWon: 2, standardLost: 2 },
  repeat: { won: 0, lost: 0, newWon: 3, newLost: 2 },
  nurture: { leads: 2, converted: 1 },
  objections: [{ kind: 'price', raised: 2, open: 0, lost: 1 }],
  sources: [{ source: 'web_form', leads: 2, won: 1 }],
  agents: [{ agent: 'sales', runs: 3, succeeded: 2, failed: 1, costMinor: 210, avgLatencyMs: 1500 }],
};

describe('parsing', () => {
  test('a report parses into the groups the page prints', () => {
    const r = parseCommercialReport(sample)!;
    assert.equal(r.deals.avgWonValueMinor, 200000);
    assert.deepEqual(r.discount.discounted, { won: 1, lost: 1 });
    assert.deepEqual(r.discount.plain, { won: 2, lost: 1 });
    assert.deepEqual(r.trustOffer.trust, { won: 1, lost: 0 });
    assert.deepEqual(r.trustOffer.standard, { won: 2, lost: 2 });
    assert.deepEqual(r.repeat.fresh, { won: 3, lost: 2 });
    assert.equal(r.discount.decisions.approved, 1, 'a numeric string is read as a number');
    assert.equal(r.agents[0]!.avgLatencyMs, 1500);
  });

  test('null in, null out: a caller who may not read gets nothing, never a report of zeros', () => {
    assert.equal(parseCommercialReport(null), null);
    assert.equal(parseCommercialReport([]), null);
    assert.equal(parseCommercialReport('x'), null);
  });

  test('an average with nothing to average stays null', () => {
    const r = parseCommercialReport({ ...sample, deals: { won: 0, lost: 0, wonValueMinor: 0, avgWonValueMinor: null }, discount: { ...sample.discount, avgPct: null } })!;
    assert.equal(r.deals.avgWonValueMinor, null);
    assert.equal(r.discount.avgPct, null);
  });

  test('missing groups parse as empty, not as a crash', () => {
    const r = parseCommercialReport({ days: 30 })!;
    assert.deepEqual(r.objections, []);
    assert.deepEqual(r.sources, []);
    assert.deepEqual(r.agents, []);
    assert.equal(r.nurture.leads, 0);
  });
});

describe('a rate is null when nothing closed, never 0%', () => {
  test('rates', () => {
    assert.equal(closeRate({ won: 0, lost: 0 }), null);
    assert.equal(closeRate({ won: 0, lost: 4 }), 0);
    assert.equal(closeRate({ won: 3, lost: 1 }), 0.75);
  });
});

describe('the SQL is a read, scoped to the caller, and says what it counts', () => {
  const code = migration.replace(/--.*$/gm, '');

  test('it writes nothing', () => {
    assert.equal(/\binsert\s+into\b|\bdelete\s+from\b|\bupdate\s+\w+\.\w+\s+set\b|\bcreate\s+table\b/i.test(code), false);
    assert.match(code, /language plpgsql\s+stable\s+security definer/);
  });

  test('internal members of one organization only, never anon', () => {
    assert.match(code, /not coalesce\(\(select core\.is_internal\(\)\), false\) or v_org is null then return null/);
    assert.match(code, /revoke all on function sales\.p1s_commercial_report\(integer\) from public, anon;/);
    assert.match(code, /grant execute on function sales\.p1s_commercial_report\(integer\) to authenticated, service_role;/);
    // the live verifier (scripts/verify-p1s-commercial-report.sql) proves another organization sees none of it, and red-proofs the filter; here the filter must be present on every table the function reads
    const reads = (code.match(/\bfrom (?:sales|crm|ai)\.\w+/g) ?? []).length;
    const filters = (code.match(/organization_id = v_org/g) ?? []).length;
    assert.ok(filters >= reads - 3, `${filters} organization filters for ${reads} table reads`);
    assert.equal(/organization_id = v_org/.test(code), true);
  });

  test('the window is clamped', () => {
    assert.match(code, /least\(greatest\(coalesce\(p_days, 90\), 1\), 730\)/);
  });
});

describe('wiring: the funnel page shows the report, and says the funnel itself carries no money', () => {
  const page = read('app/(internal)/sales-funnel/page.tsx');
  test('the page reads the report for the same window as the funnel and renders it', () => {
    assert.match(page, /const commercial = await readCommercialReport\(days\);/);
    assert.match(page, /<CommercialReport report=\{commercial\} \/>/);
    assert.ok((REPORT_WINDOWS as readonly number[]).includes(90));
  });

  test('the read reports a failure instead of showing an empty report', () => {
    const q = read('src/modules/sales/p1s-commercial-queries.ts');
    assert.match(q, /if \(error\) unreadable\('readCommercialReport', error\)/);
  });

  test('the component prints "no deals" for an empty rate and warns that a discount winning is not proof it caused the win', () => {
    const c = read('app/(internal)/sales-funnel/commercial-report.tsx');
    assert.match(c, /r === null \? 'no deals'/);
    assert.match(c, /not evidence that the discount caused it/);
  });
});
