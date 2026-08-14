import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

/**
 * An opportunity the team is told about — gap G-036, decision ADM-22 §2.7.
 *
 * The rule is absolute and predates this work:
 *
 *   "There is no price catalog. Every price is quoted per client, by a human.
 *    AgencyOS may identify an opportunity — a completed project, a support
 *    pattern, a feature request — and tell the team. **It must never state a
 *    price**."
 *
 * So the tests worth having are the ones that fail if a later change lets
 * AgencyOS price something or send something. Both are asserted as absences,
 * because that is the form the rule takes.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260814120009_an_opportunity_the_team_is_told_about.sql');
const detector = read('../src/lib/sales/upsell.ts');
const rules = read('../docs/business-os/02-business-rules.md');

/** The table definition alone, so prose in the header cannot satisfy a check. */
const tableDef = migration.slice(
  migration.indexOf('create table if not exists sales.upsell_signals'),
  migration.indexOf('comment on table sales.upsell_signals'),
);

describe('A. it cannot state a price, structurally', () => {
  test('the table has no column that could hold one', () => {
    // ADM-22's surest enforcement: there is nowhere to put a price. A future
    // change that wanted to price an opportunity would have to alter the
    // table, which is a reviewable act rather than a quiet one.
    const columns = [...tableDef.matchAll(/^\s{2}(\w+)\s+/gm)].map((m) => m[1]);
    assert.ok(columns.length > 5, 'the column parse found almost nothing, so it proves nothing');
    for (const column of columns) {
      assert.ok(
        !/price|amount|minor|cost|discount|rate|fee/i.test(column ?? ''),
        `the upsell table gained a column that can hold money: ${column}`,
      );
    }
  });

  test('and nothing in the detector computes one', () => {
    // Comments stripped: this file quotes §2.7, which contains the word
    // "price", so searching the raw text finds the rule it is enforcing and
    // fails on it. A claim about code is checked against code.
    assert.ok(
      !/price|amount_minor|total_minor|discount/i.test(codeOnly(detector)),
      'the detector reaches for a monetary value',
    );
  });
});

describe('B. it cannot send anything', () => {
  test('the detector has no send path', () => {
    // "Tell the team" is satisfied by a row the team can see. Sending would
    // need a channel, and the only one that exists reserves its internal group
    // for approvals — mixing opportunities in would turn a channel that must
    // be read into one that can be ignored.
    for (const forbidden of ['send_outbound_message', 'sendClientMessage', 'announce']) {
      assert.ok(!detector.includes(forbidden), `the detector calls ${forbidden}`);
    }
  });

  test('and the migration creates no client-facing surface', () => {
    assert.ok(
      !/is_client\(\)/.test(migration),
      'a client can reach the upsell signals, which is exactly what §2.7 guards against',
    );
    assert.match(migration, /create policy upsell_signals_select[\s\S]{0,200}core\.is_internal\(\)/);
  });
});

describe('C. the trigger came from the business rules, not from invention', () => {
  test('§2.7 names the signals this implements', () => {
    // The kinds are a mapping of a sentence that already existed, not a
    // judgement about what makes a good opportunity.
    assert.match(rules, /completed project/);
    assert.match(rules, /feature request/);
    assert.match(rules, /must never state a price/);
  });

  test('only the two observable ones are implemented', () => {
    assert.match(migration, /check \(kind in \('project_completed', 'scope_added'\)\)/);
  });

  test('the support-pattern signal is deliberately absent', () => {
    // Maintenance has no model yet (G-034), so there is no pattern to observe.
    // An invented proxy would be a made-up signal wearing §2.7's clothes.
    assert.ok(!/support_pattern/.test(tableDef), 'a signal was implemented with nothing to observe');
    assert.match(migration, /G-034/);
  });

  test('and no threshold or score was invented', () => {
    // "Three modules in thirty days" would be a business rule nobody wrote.
    // Comments stripped for the same reason: the migration header says
    // "No thresholds, no scores" and names the threshold it declined to add.
    assert.ok(
      !/interval '\d+ (day|month)'|score|weight|threshold/i.test(codeOnly(migration)),
      'the detector applies a threshold that no business rule states',
    );
  });
});

describe('D. the same opportunity is not reported twice', () => {
  test('idempotence is a constraint, not detector caution', () => {
    // The tick runs every minute. Without this it would file the same
    // completed project sixty times an hour — and a second detector would not
    // inherit a first detector's carefulness.
    assert.match(migration, /unique \(organization_id, project_id, kind\)/);
    assert.match(migration, /on conflict \(organization_id, project_id, kind\) do nothing/);
  });

  test('a dismissal is remembered rather than deleted', () => {
    // The same signal firing again after a human said no is noise, and the
    // only way to know is to remember the no.
    assert.match(migration, /check \(status in \('open', 'acted_on', 'dismissed'\)\)/);
  });

  test('and a review is a person and a time, or neither', () => {
    assert.match(migration, /check \(\(reviewed_by is null\) = \(reviewed_at is null\)\)/);
  });
});
