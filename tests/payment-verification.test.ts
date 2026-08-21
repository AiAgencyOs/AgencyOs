import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const migration = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => f.includes('a_payment_is_claimed_then_verified'))
  .map((f) => readFileSync(join(root, 'supabase/migrations', f), 'utf8'))
  .join('\n');

/**
 * The SQL with every form of prose removed — `--` lines and `comment on … is`
 * bodies both.
 *
 * Every "this must NOT appear" assertion below runs against this rather than
 * the raw file, because a migration that explains a prohibition necessarily
 * contains the words it forbids. This repository has now caught that mistake
 * four times, in four different checks; the fifth is cheaper as a helper.
 */
const sql = migration
  .replace(/comment on [\s\S]*?';/g, '')
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

/**
 * A payment is claimed, then verified.
 *
 * The refusals are constraints and a transition function, proved against real
 * Postgres by `db:verify:paymentverify`. What this file protects is the
 * ABSENCE at the centre of it — there is no `verified_by_agent` column — and
 * absences are what get filled in by somebody who does not know why they are
 * empty.
 */
describe('Doc 15 — a claim, and the person who checks it', () => {
  test('there is no way for an agent to verify a payment', () => {
    // §12: "Agents must not fabricate verification evidence."
    // §36: "Do not allow agent self-approval for high-risk financial actions."
    //
    // Not a check an agent could fail — a column that does not exist. Same
    // shape as ADM-22's missing pricing tool: the capability is absent rather
    // than guarded, because a guarded capability is one somebody argues about.
    assert.ok(migration, 'the migration is missing');
    assert.doesNotMatch(sql, /verified_by_agent/);
    assert.match(migration, /verified_by\s+uuid references core\.users/);
    // And an agent may still SUBMIT — reading "paid, UTR 402318" out of a
    // client's message and recording it as a claim is exactly right.
    assert.match(migration, /submitted_by_agent\s+text references ai\.agents/);
  });

  test('verifying records a verifier AND evidence, or the status cannot say verified', () => {
    // §12: "Manual verification must record verifier and evidence."
    assert.match(migration, /payment_submissions_verified_is_evidenced/);
    for (const clause of ['verified_by is not null', 'verified_at is not null', 'verification_evidence is not null']) {
      assert.ok(migration.includes(clause), `missing: ${clause}`);
    }
  });

  test('and a rejection says why — in the row, not only in the function', () => {
    // Red-proving found this one uncovered: with only the RPC exercised,
    // dropping the constraint changed nothing, because the function answers
    // `no_reason` before the row is ever written. A rule that only holds
    // through one caller is a rule the next caller does not have.
    assert.match(migration, /payment_submissions_rejection_says_why/);
    assert.match(migration, /status <> 'rejected'/);
  });

  test('verifying does not move money', () => {
    // A second place money can enter is a second place the invoice ceiling can
    // be missed, and audit finding D1 is what that costs. The transition
    // function writes a status, a verifier and evidence — nothing else.
    const fn = sql.slice(sql.indexOf('function finance.verify_payment_submission'));
    assert.doesNotMatch(fn, /insert into finance\.payments/);
    assert.doesNotMatch(fn, /record_manual_payment/);
    assert.doesNotMatch(fn, /paid_minor/);
    // The link back to the ledger exists, and is filled in by whoever records
    // the payment — not by verification.
    assert.match(migration, /payment_id\s+uuid references finance\.payments/);
  });

  test('a claim has exactly one author, so "who said this" has one answer', () => {
    assert.match(migration, /payment_submissions_has_one_author/);
    assert.match(migration, /\(submitted_by is null\) <> \(submitted_by_agent is null\)/);
  });

  test('an exact reference, exactly once, case-folded', () => {
    // §36 "Require exact references for payment matching" and §12 "Duplicate
    // references are flagged". A UTR retyped in a different case is the same
    // UTR. Rejected and duplicate rows are excluded — those exist precisely to
    // record that the reference was seen before.
    assert.match(migration, /unique index[\s\S]*?payment_submissions_reference_key[\s\S]*?upper\(reference\)/);
    assert.match(migration, /status not in \('rejected', 'duplicate'\)/);
  });

  test('§11’s status vocabulary is used as written', () => {
    for (const status of ['pending_verification', 'verified', 'rejected',
                          'partially_verified', 'duplicate', 'refunded']) {
      assert.ok(migration.includes(`'${status}'`), `Doc 15 §11 names ${status} and the CHECK does not`);
    }
  });

  test('what is not built is written down rather than left looking finished', () => {
    // Reconciliation (§15, §29) reconciles against bank or gateway statements
    // and AgencyOS imports neither. The invoice-side snapshot of §9's last
    // bullet needs the invoice engine to record which account it named.
    // Both are named in the migration, because a document half-implemented
    // without saying so reads as a document implemented.
    assert.match(migration, /Reconciliation \(§15, §29\) is not here/);
    assert.match(migration, /invoice-side snapshot of §9's last bullet is not here/);
  });
});
