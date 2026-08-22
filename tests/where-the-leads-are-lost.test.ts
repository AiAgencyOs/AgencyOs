import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * The funnel's arithmetic, and the two things it refuses to do.
 *
 * Doc 09 §37 names ten conversions and §38 ends *"CRM analytics are
 * available."* They were not. The counting itself is proved against real
 * Postgres in `verify-sales-funnel.mjs`, where a planted cohort's every stage
 * is known by construction; what is settled here is the part between the
 * counts and the screen — the rates, the leak, and the refusals.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const MIGRATION = read('supabase/migrations/20260823150000_where_the_leads_are_lost.sql');
const PAGE = read('app/(internal)/sales-funnel/page.tsx');

/**
 * Read as source rather than imported.
 *
 * `sales-funnel.ts` is `server-only` and reaches `next/headers`, which does not
 * resolve in the test runner — the same reason every other file here reads its
 * subject as text. What is asserted is the rule, in the one place it is
 * written; the behaviour is proved against real Postgres in
 * `verify-sales-funnel.mjs`.
 */
const READER = read('src/lib/admin/sales-funnel.ts');

describe('A. the rates, and what a percentage of nothing is', () => {
  test('a percentage of zero is null, never 0%', () => {
    // Printing "0%" would name a stage as the leak when no lead ever arrived
    // to leak.
    assert.match(READER, /of > 0 \? Math\.round\(\(n \/ of\) \* 1000\) \/ 10 : null/);
    assert.match(READER, /rate: previous === null \? null : pct\(count, previous\)/);
  });

  test('an average over no rows is null, not zero hours', () => {
    const code = sqlCode(MIGRATION);
    // avg() over an empty set is null in Postgres, and nothing here coalesces
    // it. A dashboard reading "0h response time" on an empty month is the
    // false calm this codebase refuses everywhere else.
    assert.doesNotMatch(code, /coalesce\(\s*avg\(/i);
    const reader = read('src/lib/admin/sales-funnel.ts');
    assert.match(reader, /hoursToFirstReply: row\?\.hours_to_first_reply \?\? null/);
  });

  test('it will not name a leak from too few leads', () => {
    const floor = Number(/MIN_LEADS_TO_NAME_A_LEAK = (\d+)/.exec(READER)?.[1] ?? 0);
    assert.ok(floor >= 20, `the floor must be a real one, found ${floor}`);
    assert.match(READER, /if \(counts\.leads >= MIN_LEADS_TO_NAME_A_LEAK\)/);
    // …and it says so where a reader can see it, rather than showing nothing.
    assert.match(PAGE, /the biggest drop is noise/);
  });

  test('budget sits beside the funnel, not in it', () => {
    const ordered = READER.slice(READER.indexOf('const ordered'), READER.indexOf('const steps'));
    assert.doesNotMatch(ordered, /budgetKnown/, 'a stage that is not a stage invents a loss');
    // It is still reported — plenty of leads are quoted without one.
    assert.match(PAGE, /have a budget on file/);
  });
});

describe('B. what the funnel refuses to invent', () => {
  const code = sqlCode(MIGRATION);

  /**
   * Doc 09 §6 defines QUALIFIED as *"enough information to pursue"* and
   * nobody has said what enough is. A threshold on qualification areas would
   * be this file deciding a business rule, which is what ADM-22 and ADM-88
   * both refused in their own areas.
   */
  test('no threshold decides that N answered areas means qualified', () => {
    const qualified = code.slice(code.indexOf('qualified_leads as ('), code.indexOf('requirements_done as ('));
    assert.match(qualified, /c\.status in \('qualified', 'converted'\)/);
    assert.doesNotMatch(qualified, /count\(/, 'a count of areas would be an invented threshold');
    assert.doesNotMatch(qualified, /qualification_coverage/);
  });

  test('no money — an average of unset values is a fabricated KPI', () => {
    for (const column of ['value_minor', 'total_minor', 'discount_minor', 'subtotal_minor']) {
      assert.doesNotMatch(code, new RegExp(column), `the funnel must not read ${column}`);
    }
    // And the page says why, rather than leaving a reader to wonder.
    assert.match(PAGE, /an average of nulls is not a\s*\n?\s*number/);
  });

  /**
   * The one that matters most. A funnel is usually forced monotone — a won
   * lead counted as having reached every earlier stage. Here that would be
   * false: ADM-13 lets a project start on an advance, requirements and a
   * group, with no proposal row anywhere.
   */
  test('the stages are not nested — nothing infers an earlier stage from a later one', () => {
    const quoted = code.slice(code.indexOf('quoted_leads as ('), code.indexOf('negotiating_leads as ('));
    assert.doesNotMatch(quoted, /stage = 'won'/, 'a won deal must not be counted as quoted');
    assert.match(quoted, /p\.status = 'sent'/, 'only a quotation the client received');
  });

  test('and an out-of-order pair is surfaced rather than smoothed', () => {
    assert.match(READER, /const outOfOrder = steps\.some/);
    assert.match(PAGE, /without the record for the one before it/);
  });
});

describe('C. whose numbers they are', () => {
  const code = sqlCode(MIGRATION);

  test('an authenticated caller is pinned to its own organization', () => {
    assert.match(code, /when \(select auth\.uid\(\)\) is not null then \(select core\.current_organization_id\(\)\)/);
  });

  test('and with no organization it returns nothing rather than everything', () => {
    assert.match(code, /if v_org is null then\s+return;/);
  });

  test('every stage is scoped to that organization, not only the cohort', () => {
    // The cohort is org-scoped, but a join that is not would let another
    // tenant's message or deal attach to it.
    const body = code.slice(code.indexOf('with cohort as ('), code.indexOf('comment on function'));
    const joins = [...body.matchAll(/join (crm|sales)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`);
    assert.ok(joins.length >= 6, `expected the stage joins, found ${joins.length}`);
    const scoped = (body.match(/organization_id = v_org/g) ?? []).length;
    assert.ok(scoped >= joins.length, `every joined table must be org-scoped: ${scoped} scopes for ${joins.length} joins`);
  });

  test('it is read-only — a report that could write is not a report', () => {
    for (const write of ['insert into', 'update ', 'delete from']) {
      assert.doesNotMatch(code, new RegExp(write, 'i'), `the funnel must not ${write.trim()}`);
    }
    assert.match(code, /language plpgsql\s+stable/);
  });
});

describe('D. the page says what it is looking at', () => {
  test('every stage names the row it counted', () => {
    for (const evidence of [
      'a lead created in the window',
      'the agency sent something on their thread',
      'they wrote back after we did',
      'the lead’s own status',
      'a person accepted a requirement version',
      'a proposal marked sent',
      'a deal at the negotiation stage',
      'a deal at the won stage',
    ]) {
      assert.ok(READER.includes(evidence), `missing evidence line: ${evidence}`);
    }
    assert.match(PAGE, /\{step\.evidence\}/);
  });

  test('an empty window says there is nothing to measure, not zero percent', () => {
    assert.match(PAGE, /there is nothing to measure yet/);
    assert.match(PAGE, /it does not estimate/);
  });
});
