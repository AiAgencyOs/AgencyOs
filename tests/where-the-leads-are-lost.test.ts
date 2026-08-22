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

/**
 * E. why they were lost — Doc 09 §25, §37 and §38.
 *
 * §38's acceptance criteria says *"LOST requires a reason"* and it was true of
 * `setOpportunityStage` and only of it: the service refused an empty reason
 * and the row did not, so a write straight through PostgREST settled a deal
 * with nothing recorded. The half-a-check shape, again.
 *
 * And a free-text reason cannot be counted. §37 asks for a distribution; ten
 * deals lost for one cause, described ten ways, group into ten rows of one.
 */
describe('E. a lost deal says why, countably and in words', () => {
  const MIGRATION2 = sqlCode(read('supabase/migrations/20260823180000_a_lost_deal_says_why.sql'));

  test('the categories are Doc 09 §25’s, not an invented list', async () => {
    const { LOST_CATEGORIES } = await import('../src/modules/sales/schema.ts');
    assert.equal(LOST_CATEGORIES.length, 11);
    for (const named of [
      'price_too_high', 'no_budget', 'chose_competitor', 'project_postponed',
      'no_response', 'not_a_fit', 'requirements_changed', 'trust_not_established',
      'timeline_mismatch', 'client_cancelled', 'other',
    ]) {
      assert.ok((LOST_CATEGORIES as readonly string[]).includes(named), `§25 names ${named}`);
    }
    // Every one is offered on a screen, or it is a value nobody can choose.
    const { LOST_CATEGORY_LABELS } = await import('../src/modules/sales/schema.ts');
    for (const c of LOST_CATEGORIES) {
      assert.ok(LOST_CATEGORY_LABELS[c], `${c} has no label`);
    }
  });

  test('and the vocabulary is the same in both places', () => {
    // A CHECK the schema mirrors is two lists that must agree; a drift makes
    // the dropdown offer a value the row refuses.
    const check = MIGRATION2.slice(MIGRATION2.indexOf('lost_category text'));
    for (const named of ['price_too_high', 'chose_competitor', 'client_cancelled', 'other']) {
      assert.match(check.slice(0, 900), new RegExp(`'${named}'`));
    }
  });

  test('the row requires both halves, not just the one the service checked', () => {
    assert.match(MIGRATION2, /add constraint opportunities_lost_says_why check \(/);
    const c = MIGRATION2.slice(MIGRATION2.indexOf('opportunities_lost_says_why check ('));
    const body = c.slice(0, c.indexOf(') not valid'));
    assert.match(body, /lost_category is not null/);
    assert.match(body, /length\(btrim\(coalesce\(lost_reason, ''\)\)\) > 0/);
  });

  /**
   * ADM-76: a record invented now is indistinguishable from one made at the
   * time. A report reading "37 lost: other" would be reading this migration,
   * not a judgement anybody made.
   */
  test('history is not backfilled — the constraint binds forward only', () => {
    assert.match(MIGRATION2, /\) not valid;/);
    assert.doesNotMatch(MIGRATION2, /update sales\.opportunities\s+set lost_category/i);
    // And an uncategorised loss is named as such rather than folded into
    // 'other', which would be the same backfill by a different route.
    assert.match(MIGRATION2, /'not recorded'/);
  });

  test('a reopened deal carries none of it forward', () => {
    const fn = MIGRATION2.slice(MIGRATION2.indexOf('function sales.clear_settlement_on_reopen'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    for (const cleared of ['closed_at', 'lost_reason', 'lost_category']) {
      assert.match(body, new RegExp(`new\\.${cleared}\\s+:= null`), `${cleared} must be cleared`);
    }
  });

  test('the distribution returns nothing when nothing was lost, not zeroes', () => {
    const fn = MIGRATION2.slice(MIGRATION2.indexOf('function sales.lost_reasons'));
    assert.match(fn.slice(0, fn.indexOf('$$;')), /if v_total = 0 then\s+return;/);
  });

  test('and it is pinned to the caller’s own organization, like the funnel', () => {
    assert.match(MIGRATION2, /when \(select auth\.uid\(\)\) is not null then \(select core\.current_organization_id\(\)\)/);
    assert.match(MIGRATION2, /language plpgsql\s+stable/);
  });
});

/**
 * F. who needs you first — Doc 09 §31, under ADM-88.
 *
 * §31 lists nine signals and §10 lists ten dimensions with *"configurable
 * weights"*. ADM-88 refused all of it: *"no numeric lead score and no invented
 * weights… Priority is a deterministic fact-tier order."*
 *
 * The ordering itself is proved against real Postgres in
 * `verify-sales-funnel.mjs` §K, where two leads in known states are planted
 * and their positions checked. What is settled here is that the shape cannot
 * become a score.
 */
describe('F. a queue, not a score', () => {
  const MIGRATION3 = sqlCode(read('supabase/migrations/20260823190000_who_needs_you_first.sql'));
  const PAGE2 = read('app/(internal)/leads/page.tsx');

  test('nothing it returns is a number anybody could tune', () => {
    const signature = MIGRATION3.slice(MIGRATION3.indexOf('returns table ('), MIGRATION3.indexOf('language plpgsql'));
    for (const number of ['score', 'weight', 'points', 'rank', 'priority']) {
      assert.doesNotMatch(signature, new RegExp(`\\b${number}\\b`), `${number} must not be returned`);
    }
    // What it returns instead: which tier, and how long it has been in it.
    assert.match(signature, /reason\s+text/);
    assert.match(signature, /waiting_since timestamptz/);
  });

  test('every tier is a recorded fact, not a judgement', () => {
    for (const [tier, fact] of [
      ['handed_over', /agent_paused_at is not null/],
      ['waiting_on_us', /author_type = 'client'/],
      ['quoted_no_answer', /p\.status = 'sent'/],
      ['ready_to_quote', /r\.status = 'accepted'/],
      ['open_objection', /ob\.response is null/],
    ] as const) {
      assert.match(MIGRATION3, new RegExp(`'${tier}'`), `${tier} must be a tier`);
      assert.match(MIGRATION3, fact, `${tier} must come from a row`);
    }
  });

  test('a settled lead is nobody’s morning', () => {
    assert.match(MIGRATION3, /l\.status not in \('converted', 'disqualified'\)/);
    assert.match(MIGRATION3, /l\.deleted_at is null/);
  });

  /**
   * The difference from `crm.reactivation_priority`, and it is deliberate.
   * That one feeds an outbound queue and is consent-gated; this feeds a
   * person's morning. A client who wrote to us yesterday must appear whether
   * or not anybody has recorded a consent row for them.
   */
  test('and it is not consent-gated, unlike the outbound ranking', () => {
    assert.doesNotMatch(MIGRATION3, /communication_consent/);
    // The reasoning is in the header, which `sqlCode` strips — read raw.
    assert.match(
      read('supabase/migrations/20260823190000_who_needs_you_first.sql'),
      /feeds a person's morning/,
    );
  });

  test('the tie-break is stable, so the page does not shuffle between loads', () => {
    const order = MIGRATION3.slice(MIGRATION3.indexOf('order by'));
    assert.match(order, /live\.id\s*\n?\s*limit/);
  });

  test('the page names an action, not a state', () => {
    assert.match(PAGE2, /Asked for a person/);
    assert.match(PAGE2, /Waiting on us/);
    assert.match(PAGE2, /Ready to quote/);
  });

  test('and it refuses on a failed read rather than saying nobody needs you', () => {
    const queries = read('src/modules/crm/queries.ts');
    const fn = queries.slice(queries.indexOf('export async function listLeadsNeedingAttention'));
    assert.match(fn.slice(0, fn.indexOf('\n}')), /unreadable\('listLeadsNeedingAttention', error\)/);
  });
});
