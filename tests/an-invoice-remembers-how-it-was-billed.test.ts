import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * An invoice remembers how it was billed — Finance §4.2, §5, §15.
 *
 * §5: *"Billing data used on each issued invoice should be snapshotted/
 * versioned for audit."* G-255 versioned the profile and G-259 made the
 * invoice carry the right tax; neither recorded **which version decided it**.
 * A client who changes their registered address between M1 and M3 leaves two
 * invoices that were each correct under different profiles, and nothing on
 * either row said which.
 *
 * The interesting decision is that this is a **reference, not a copy** — the
 * opposite of what G-253 did for the group's member list, and for a reason
 * worth being able to state.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917170000_an_invoice_remembers_how_it_was_billed.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
/**
 * The LIVE definition, which is in `20260815290000` and not in the migration
 * that first created the function. Establishing which is last is the whole
 * discipline: the first draft of this change carried the original forward and
 * dropped a capability added in between.
 */
const ORIGINAL = read('supabase/migrations/20260815290000_an_invoice_moves_only_through_its_engine.sql');
const SERVICE = read('src/modules/finance/service.ts');

describe('A. a reference, because the row it points at cannot change', () => {
  test('it is a foreign key, not a jsonb copy of the billing fields', () => {
    assert.match(
      SQL,
      /add column if not exists billing_profile_id uuid\s*\n\s*references finance\.billing_profiles\(id\) on delete restrict/,
    );
    assert.doesNotMatch(SQL, /billing_snapshot|legal_name|gstin\s+text|billing_address/);
  });

  test('and the reason is the profile’s own freeze, stated against G-253’s opposite choice', () => {
    assert.match(PROSE, /a copy would be a second source that can only\s+drift by being wrong/);
    // The contrast is the part worth keeping: the same repository copies in
    // one place and references in another, on purpose.
    assert.match(PROSE, /The group setup's member list IS copied \(G-253\), and the difference is worth\s+stating/);
  });

  test('`on delete restrict` is what makes the reference trustworthy', () => {
    assert.match(SQL, /on delete restrict/);
    assert.match(PROSE, /cannot be deleted while that invoice exists/);
  });

  test('the column is org-guarded like every other reference here', () => {
    assert.match(
      SQL,
      /create trigger org_match_invoices_billing_profile[\s\S]{0,220}enforce_parent_org\('billing_profile_id', 'finance\.billing_profiles'\)/,
    );
  });
});

describe('B. old invoices are left alone rather than backfilled into a claim', () => {
  test('the column is nullable and nothing backfills it', () => {
    assert.doesNotMatch(SQL, /update finance\.invoices\s+set billing_profile_id/);
    // The COLUMN definition, not the file: the partial index's predicate is
    // `where billing_profile_id is not null`, and a bare /not null/ over the
    // whole migration reads that as the column being required.
    const addColumn = SQL.slice(SQL.indexOf('add column if not exists billing_profile_id'), SQL.indexOf('create index'));
    assert.doesNotMatch(addColumn, /not null/);
    // The twin: the index IS partial, so the nulls it is not indexing are the
    // old invoices this deliberately left alone.
    assert.match(SQL, /where billing_profile_id is not null/);
  });

  test('and the record says what null means', () => {
    assert.match(PROSE, /null means "raised before this system recorded billing\s+modes", which is true/);
    assert.match(PROSE, /it would assert that an\s+invoice from August was billed under a mode confirmed in September/);
  });
});

describe('C. the door was carried forward verbatim', () => {
  test('three edits, all marked', () => {
    // Upper case, and from the RAW migration: the edit marks are comments, and
    // the comment-stripped SQL would have removed the very thing this checks.
    const rawStart = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION finance.create_milestone_invoice');
    assert.ok(rawStart > 0, 'the carried definition is not in this migration');
    const v2 = MIGRATION.slice(rawStart, MIGRATION.indexOf('$function$;', rawStart));
    assert.equal((v2.match(/\[G-260 edit \d of 3\]/g) ?? []).length, 3, 'more edits than are marked');

    // Every non-comment line of the LIVE definition must survive.
    const origStart = ORIGINAL.indexOf('CREATE OR REPLACE FUNCTION finance.create_milestone_invoice');
    const v1 = ORIGINAL.slice(origStart, ORIGINAL.indexOf('$function$;', origStart));
    const original = v1
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('--'))
      // The three lines the marked edits deliberately replaced. Named
      // individually, so a fourth silent change still fails.
      .filter((l) => !['due_at, notes', 'p_due_at, p_notes'].includes(l))
      .filter((l) => !l.startsWith('CREATE OR REPLACE FUNCTION'));
    const carried = v2.split('\n').map((l) => l.trim());
    assert.deepEqual(original.filter((l) => !carried.includes(l)), [], 'lines dropped in the carry-forward');

    // The line the first draft of this migration DROPPED, by carrying forward a
    // superseded definition. Without it the invoices guard refuses every
    // authenticated caller's write through this door.
    assert.match(v2, /perform set_config\('finance\.sanctioned_write', 'on', true\)/);
  });

  test('the new argument is last and defaulted', () => {
    // A defaulted parameter must be last, and every caller that existed before
    // this change passed none.
    assert.match(MIGRATION, /p_notes text DEFAULT NULL::text,[\s\S]{0,300}p_billing_profile_id uuid DEFAULT NULL::uuid\)/);
  });

  test('the old twelve-argument signature is DROPPED, not left as an overload', () => {
    // Adding a defaulted parameter creates an overload in PostgreSQL, it does
    // not replace. Both would exist, and every caller still passing twelve
    // arguments would bind to the OLD one — raising an invoice with the right
    // tax and no record of which profile decided it, which is the gap this
    // migration exists to close. Found by asking the scratch database what it
    // actually had: two rows from pg_proc where one was expected.
    assert.match(
      SQL,
      /drop function if exists finance\.create_milestone_invoice\(\s*\n?\s*uuid, uuid, uuid, uuid, text, character, bigint, bigint, bigint, jsonb, timestamptz, text\s*\n?\s*\);/,
    );
    // And it is dropped BEFORE the new one is created, or the drop would take
    // the function that was just defined.
    assert.ok(SQL.indexOf('drop function if exists finance.create_milestone_invoice') < SQL.indexOf('CREATE OR REPLACE FUNCTION finance.create_milestone_invoice'));
  });

  test('it is still the one insert path for a milestone invoice', () => {
    assert.equal((MIGRATION.match(/insert into finance\.invoices/gi) ?? []).length, 1);
  });
});

describe('D. the service passes the version it actually read', () => {
  test('the readiness read returns the profile row’s id', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('export async function readBillingReadiness'));
    assert.match(fn, /profileId: data\?\.id \?\? null/);
    assert.match(fn, /\.select\('id, version, mode/);
  });

  test('and the invoice is raised against that same row', () => {
    assert.match(SERVICE, /p_billing_profile_id: readiness\.data\.profileId \?\? undefined/);
    // The same `readiness` that decided the tax rate — not a second read that
    // could land on a newer version between the two.
    const rateAt = SERVICE.indexOf('const taxRateBp = taxRateBpForMode(readiness.data.mode)');
    const passAt = SERVICE.indexOf('p_billing_profile_id: readiness.data.profileId');
    const secondRead = SERVICE.indexOf('readBillingReadiness', SERVICE.indexOf('readBillingReadiness') + 1);
    assert.ok(rateAt > 0 && passAt > rateAt);
    assert.ok(
      secondRead === -1 || secondRead > passAt,
      'a second profile read between the rate and the write could bill under one version and record another',
    );
  });
});
