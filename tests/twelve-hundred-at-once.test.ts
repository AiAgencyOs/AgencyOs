import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * Twelve hundred at once — gap G-219.
 *
 * Everything the reactivation campaign needed existed and there was no way to
 * run it: the enrolment door took ONE lead id, so a campaign against twelve
 * hundred people was twelve hundred separate decisions by a person who had
 * already made the decision once.
 *
 * And a rule was being SHOWN rather than enforced. G-210 decided that a
 * client, a live deal and an agreed nurture date are not contactable, and
 * G-211 put that in front of an operator before a campaign — but
 * `crm.relationship_is_contactable` was called in exactly one place, the
 * preview. A contact who became a client last month, and who had consent
 * because they wrote in, could be enrolled by the same screen that said they
 * should not be.
 *
 * The behaviour is proved against a real Postgres by `verify-lead-import`
 * §10c, including that a converted contact is refused. What is here is the
 * shape of the bounds.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260906170000_twelve_hundred_at_once.sql'));

describe('A. the exclusion is enforced, not displayed', () => {
  test('the single-lead door asks who this contact already is', () => {
    assert.match(SQL, /crm\.relationship_is_contactable\(crm\.contact_relationship\(v_contact\)\)/);
    assert.match(SQL, /'not_contactable'/);
  });

  test('and consent is still a separate question', () => {
    // Consent is whether they agreed to be messaged; the relationship is
    // whether a sales campaign is the right thing to message them about.
    // Either alone would let the wrong message through.
    assert.match(SQL, /'no_consent'/);
    const fn = SQL.slice(SQL.indexOf('function crm.add_lead_to_reactivation_pilot'), SQL.indexOf('comment on function crm.add_lead_to_reactivation_pilot'));
    assert.ok(fn.indexOf("'no_consent'") < fn.indexOf("'not_contactable'"), 'consent is checked first');
  });

  test('the batch path goes through the single-lead one rather than repeating it', () => {
    // The failure this whole gap is an instance of: a rule in one path and
    // not the other. A rule added to the single door tomorrow cannot be
    // missing from the batch.
    assert.match(SQL, /select a\.outcome into v_result from crm\.add_lead_to_reactivation_pilot\(v_lead\) a/);
  });
});

describe('B. a ceiling, not a faucet', () => {
  test('there is a maximum the caller cannot raise', () => {
    assert.match(SQL, /c_max\s+constant int := 500/);
    assert.match(SQL, /least\(greatest\(coalesce\(p_limit, 100\), 1\), c_max\)/);
  });

  test('and the pilot gate is obeyed rather than worked around', () => {
    // Enrolling everybody into a campaign nobody has turned on is how a
    // campaign turns itself on.
    assert.match(SQL, /reactivation_pilot_enabled/);
    assert.match(SQL, /'pilot_off'/);
  });

  test('but stopping one works whatever the gate says', () => {
    const withdraw = SQL.slice(SQL.indexOf('function crm.withdraw_reactivation_batch'));
    assert.doesNotMatch(withdraw, /pilot_off|reactivation_pilot_enabled/);
  });
});

describe('C. it says what it did, and what it refused', () => {
  test('every outcome is counted, not silently skipped', () => {
    assert.match(SQL, /enrolled\s+int,\s*\n\s*already_in\s+int,\s*\n\s*no_consent\s+int,\s*\n\s*not_contactable\s+int/);
  });

  test('including records that never became a lead at all', () => {
    // An operator reading "enrolled 40" needs to know whether the other sixty
    // were refused or were never committed.
    assert.match(SQL, /uncommitted/);
  });

  test('and how many are left for the next pass', () => {
    assert.match(SQL, /remaining/);
  });

  test('the audit records the bound it actually used', () => {
    assert.match(SQL, /'limit', v_limit/);
  });
});

describe('D. enrolment is eligibility, never a send', () => {
  test('nothing here queues a job or emits an event', () => {
    assert.doesNotMatch(SQL, /insert into core\.jobs/);
    assert.doesNotMatch(SQL, /insert into core\.outbox_events/);
    assert.doesNotMatch(SQL, /send_outbound_message/);
  });

  test('and the operator is told so in the words they read', () => {
    const actions = codeOnly(read('app/(internal)/import/actions.ts'));
    assert.match(actions, /Nothing has been sent/);
  });
});
