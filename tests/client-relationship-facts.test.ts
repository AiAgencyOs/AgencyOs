import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

/**
 * What the record says about a client — gap G-037, filed as "client lifetime
 * model".
 *
 * **Nothing in AgencyOS defines lifetime value.** *Lifetime*, *LTV*,
 * *retention* and *churn* appear in no business document; the only occurrence
 * anywhere is the gap's own title. So this is not a lifetime-value model, and
 * the tests exist mostly to keep it from becoming one by accident.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260814120011_what_the_record_says_about_a_client.sql');
const portal = read('../scripts/verify-client-portal.mjs');
/**
 * The view definition alone, comments stripped.
 *
 * Bounded before the `comment on view` statements as well: `codeOnly` removes
 * `--` comments but not SQL **string literals**, and those comment bodies
 * quote the very words these tests assert are absent. Stripping comments is
 * not enough when the prose lives inside a string.
 */
const body = codeOnly(
  migration.slice(
    migration.indexOf('create or replace view crm.client_relationship_facts'),
    migration.indexOf('comment on view crm.client_relationship_facts'),
  ),
);

describe('A. it reports facts, and invents no number', () => {
  test('nothing forecasts, scores or estimates', () => {
    // The failure this gap is about: presenting an inferred value as though it
    // were a historical fact.
    for (const word of ['forecast', 'predict', 'probability', 'churn', 'retention', 'score', 'estimate']) {
      assert.ok(!new RegExp(word, 'i').test(body), `the view computes something ${word}-shaped`);
    }
  });

  test('and it is not called lifetime value', () => {
    // Naming a sum of past payments "lifetime value" smuggles in a forecast:
    // the term means *expected* value over a relationship's remaining life.
    assert.ok(!/lifetime_value|ltv/i.test(body), 'the view names itself as a valuation');
    assert.match(migration, /crm\.client_relationship_facts/);
  });

  test('only money that actually arrived is counted', () => {
    // `created`, `authorized` and `failed` are not money that arrived, and
    // counting them would be the overstatement this view exists to avoid.
    assert.match(body, /p\.status = 'captured'/);
    assert.match(body, /r\.status = 'recorded'/);
  });

  test('and refunds are subtracted rather than ignored', () => {
    // Captured alone overstates what the agency kept — technically sourced and
    // practically misleading. Both inputs are exposed so the subtraction is
    // visible rather than assumed.
    assert.match(body, /payments_refunded_minor/);
    assert.match(body, /as net_received_minor/);
  });
});

describe('B. recorded and derived are kept apart', () => {
  test('the one derived column says so, and is reproducible by hand', () => {
    assert.match(migration, /DERIVED\. payments_received_minor minus payments_refunded_minor/);
  });

  test('and the recorded ones say where to go and check', () => {
    assert.match(migration, /RECORDED\. Sum of finance\.payments with status captured/);
  });
});

describe('C. a view, not a table', () => {
  test('it is created as a view', () => {
    // A stored total is wrong the moment a payment is captured, and for the
    // window in between the record disagrees with itself while looking
    // authoritative.
    assert.match(migration, /create or replace view crm\.client_relationship_facts/);
    assert.ok(!/create table[\s\S]{0,80}client_relationship/i.test(migration));
  });
});

describe('D. two separate isolation properties, and both are load-bearing', () => {
  test('security_invoker stops it crossing tenants', () => {
    // The first view in this schema. A Postgres view runs with its OWNER's
    // rights by default, so without this it reads every organization's rows
    // and hands them to any caller — RLS underneath never applies.
    //
    // Measured live when the setting was removed: another organization's row
    // came straight back.
    assert.match(migration, /with \(security_invoker = true\)/);
  });

  test('and an internal predicate stops it reaching clients', () => {
    // security_invoker is not enough on its own. A client can read their own
    // `core.client_accounts` row, so without this the view handed them an
    // internal analytics summary of themselves that nobody decided to show.
    //
    // Found by the live portal check rather than by reading the file — the
    // difference between a policy that is written and one that is exercised.
    assert.match(body, /where \(select core\.is_internal\(\)\)/);
  });

  test('and the portal proves the second one live', () => {
    assert.match(portal, /a client reads no rows from the relationship facts view/);
  });
});
