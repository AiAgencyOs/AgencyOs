import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import { LEAD_STATUSES, LEAD_TRANSITIONS, NURTURE_REASONS } from '../src/modules/crm/schema.ts';

/**
 * A lead that is not ready yet — G-203 (Doc 09 §6 and §26, audit FU-10).
 *
 * §6 lists NURTURE among the lead statuses and §26 gives it a section: not
 * ready now, budget later, waiting for a decision-maker, needs more evidence
 * — with a date to come back.
 *
 * This system had five statuses and none of them was that. What existed was a
 * nurture *rhythm*, attached to two follow-up situations, which sends. There
 * was nowhere for the lead itself to sit.
 *
 * ── and the consequence is the finding ────────────────────────────────────
 *
 * A lead that is not lost and not ready either **stayed `qualified` forever**,
 * inflating the one number the pipeline exists to report, **or was closed as
 * `disqualified` with a reason that was not true**. The second is worse: it
 * writes a false sentence into the record of why a deal was lost.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = sqlCode(read('supabase/migrations/20260904170000_a_lead_that_is_not_ready_yet.sql'));
const SERVICE = codeOnly(read('src/modules/crm/service.ts'));

describe('A. the state, and where it sits in the pipeline', () => {
  test('nurture is a lead status, in both vocabularies', () => {
    // The TypeScript list and the CHECK constraint are the same vocabulary
    // restated, so a drift here is a drift from what Postgres will accept.
    assert.ok(LEAD_STATUSES.includes('nurture' as never));
    assert.match(MIGRATION, /check \(status in \('new', 'qualifying', 'qualified', 'nurture', 'disqualified', 'converted'\)\)/);
  });

  test('reachable from anywhere a lead is still alive', () => {
    // "Not ready yet" is something you learn at any point — including from a
    // client who was about to sign.
    assert.ok(LEAD_TRANSITIONS.qualifying.includes('nurture'));
    assert.ok(LEAD_TRANSITIONS.qualified.includes('nurture'));
  });

  test('the DATABASE holds the same graph — the TypeScript list is a restatement', () => {
    /**
     * And the two drifting apart is how a state becomes unreachable in
     * production while every unit test passes. That is not hypothetical: the
     * first version of this change added `nurture` to the TypeScript map and
     * not to `crm.leads_guard`, and the live section caught it with three
     * failures reading *"a lead cannot move from qualifying to nurture"*.
     */
    assert.match(MIGRATION, /when 'qualifying' {3}then array\['qualified', 'nurture', 'disqualified', 'converted'\]/);
    assert.match(MIGRATION, /when 'qualified' {4}then array\['converted', 'nurture', 'disqualified'\]/);
    assert.match(MIGRATION, /when 'nurture' {6}then array\['qualifying', 'qualified', 'disqualified', 'converted'\]/);
    assert.match(MIGRATION, /when 'converted' {4}then array\[\]::text\[\]/);
  });

  test('and it is a waiting room, not a terminus', () => {
    // A lead comes back OUT of it, which is the entire reason it is not
    // `disqualified`.
    assert.deepEqual([...LEAD_TRANSITIONS.nurture], ['qualifying', 'qualified', 'disqualified']);
    assert.deepEqual([...LEAD_TRANSITIONS.converted], [], 'converted stays terminal');
  });

  test('the funnel stops counting it as open — and needed no change to do so', () => {
    // `crm.sales_funnel` already reads `status in ('qualified','converted')`,
    // so a lead moving to nurture leaves that set by itself. That is the
    // number the whole finding is about.
    const funnel = sqlCode(read('supabase/migrations/20260823150000_where_the_leads_are_lost.sql'));
    assert.match(funnel, /c\.status in \('qualified', 'converted'\)/);
    assert.match(read('supabase/migrations/20260904170000_a_lead_that_is_not_ready_yet.sql'), /NO CHANGE TO THE VIEW WAS NEEDED/);
  });
});

describe('B. a reason and a date, or it is not nurture', () => {
  test('§26’s four, and no fifth', () => {
    assert.deepEqual([...NURTURE_REASONS], [
      'not_ready_now',
      'budget_later',
      'waiting_for_decision_maker',
      'needs_more_evidence',
    ]);
    for (const reason of NURTURE_REASONS) {
      assert.ok(MIGRATION.includes(`'${reason}'`), `${reason} is not in the CHECK`);
    }
  });

  test('the row refuses a nurture with no reason', () => {
    // Without it, nurture is where a lead goes when nobody wants to decide,
    // and the pipeline is as untrue as it was with one more state to hide in.
    assert.match(MIGRATION, /a lead in nurture must say why/);
  });

  test('and one with no date to come back', () => {
    assert.match(MIGRATION, /a lead nobody has agreed to look at again is lost with extra steps/);
  });

  test('leaving nurture clears the reason', () => {
    // A `qualified` lead carrying "budget later" is a stale sentence that
    // reads as current.
    assert.match(MIGRATION, /elsif new\.nurture_reason is not null then\s+new\.nurture_reason := null;/);
  });

  test('the service refuses both before the row does, so a person gets a sentence', () => {
    assert.match(SERVICE, /Say why this lead is not ready/);
    assert.match(SERVICE, /Say when to come back to it/);
    assert.match(SERVICE, /That date has already passed/);
  });

  test('and the date it writes is the one the follow-up engine already reads', () => {
    // Borrowed rather than invented: a second date nobody looks at is the
    // column-with-no-consumer shape.
    assert.match(SERVICE, /next_follow_up_at: new Date\(parsed\.data\.nurtureUntil as string\)\.toISOString\(\)/);
  });
});

describe('C. who may put a lead there', () => {
  test('a person — the status setter is the internal, capability-gated one', () => {
    // Deciding somebody is not ready is a reading of their intent, and
    // business rules §5 makes treating a client's word as a fact one of the
    // five things no agent may do at any level.
    assert.match(SERVICE, /export async function setLeadStatus\([\s\S]{0,600}?requireInternal\(\)[\s\S]{0,200}?can\(context\.role, 'lead\.write'\)/);
  });

  test('and nothing in the agent workflows writes this status', () => {
    const workflows = codeOnly(read('app/api/jobs/run/workflows.ts'));
    assert.ok(!workflows.includes("'nurture'"), 'no agent may decide a client is not ready');
  });
});

describe('D. what was deliberately not built', () => {
  test('§26’s next recommended message is named, and not built', () => {
    // The follow-up composer already writes one when a situation fires, from
    // the conversation itself. A second surface holding a recommendation
    // nothing sends is the column-with-no-consumer G-130 and G-133 record.
    const prose = read('supabase/migrations/20260904170000_a_lead_that_is_not_ready_yet.sql');
    assert.match(prose, /next recommended message/);
    assert.match(prose, /column-with-no-consumer/);
  });
});
