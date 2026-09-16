import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  billingReadiness,
  checkGstin,
  gstinCheckCharacter,
  BILLING_MODES,
} from '../src/modules/finance/gstin.ts';
import { confirmBillingModeSchema, recordBillingDetailsSchema } from '../src/modules/finance/schema.ts';

/**
 * Billing mode is confirmed, not assumed — Finance §4.1–§4.3, §5, §16.
 *
 * The defect this closes is not a missing feature; it is a **disagreement the
 * system has been shipping**. Every quotation says *"All amounts are exclusive
 * of GST; 18% GST extra"* (`quotation-standards.ts` Part G) and every invoice
 * has added none, because `invoice_items.tax_rate_bp` defaults to 0 and
 * nothing recorded which it should be. §4.1's instruction is the fix: *"do not
 * infer GST preference from old messages when explicit confirmation is
 * required."*
 *
 * The doors are proven where SQL runs — on a scratch Postgres, driven through
 * psql, with five structural guards each refused on a direct write. These are
 * the rules that can be exercised as functions.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917130000_billing_mode_is_confirmed_not_assumed.sql');
const SQL = MIGRATION.replace(/^--.*$/gm, '');
/** The migration's prose with its comment markers folded — indented ones too. */
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const MODULE = read('src/modules/finance/gstin.ts');
const SERVICE = read('src/modules/finance/service.ts');
const BILLING = SERVICE.slice(SERVICE.indexOf('Billing mode and the profile it requires'));
/** The same, comment markers folded, so an assertion is not about line wrapping. */
const BILLING_PROSE = BILLING.replace(/\n\s*(\*|\/\/)\s?/g, ' ');
/** The module's CODE alone: prose about a word is not the word. */
const MODULE_CODE = MODULE.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const door = (name: string) => {
  const start = SQL.indexOf(`create or replace function finance.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. the disagreement this closes is written down', () => {
  test('the quotation still promises GST is extra — that is why a mode is needed', () => {
    const standards = read('src/modules/sales/quotation-standards.ts');
    assert.match(standards, /All amounts are exclusive of GST; 18% GST extra/);
    // And the invoice default that has been silently disagreeing with it.
    const finance = read('supabase/migrations/20260807120007_finance.sql');
    assert.match(finance, /tax_rate_bp\s+int not null default 0/);
    assert.match(PROSE, /the quotation promises the client that GST will be added, and every invoice this system has issued has added none/);
  });
});

describe('B. a mode is confirmed, never defaulted', () => {
  test('the column has no default and cannot be null', () => {
    assert.match(SQL, /mode\s+text not null check \(mode in \('gst', 'non_gst'\)\)/);
    assert.doesNotMatch(SQL, /mode\s+text[^\n]*default/);
  });

  test('there are two modes and no third, in the database and in the code', () => {
    assert.deepEqual([...BILLING_MODES], ['gst', 'non_gst']);
  });

  test('an unattended process cannot confirm one', () => {
    assert.match(door('confirm_billing_mode'), /if v_actor is null then\s*\n\s*return query select 'needs_person'/);
    assert.match(PROSE, /an unattended process confirming a billing mode is precisely an inference wearing a record's clothes/);
  });

  test('a mode that is not a mode is refused before any row is locked', () => {
    const fn = door('confirm_billing_mode');
    const invalid = fn.indexOf("'invalid_mode'");
    const lock = fn.indexOf('for update;');
    assert.ok(invalid > 0 && lock > invalid, 'a bad argument should not hold a lock on somebody’s project');
  });

  test('the schema refuses an empty string rather than reading it as “not GST”', () => {
    assert.equal(confirmBillingModeSchema.safeParse({ projectId: crypto.randomUUID(), mode: '' }).success, false);
    assert.equal(confirmBillingModeSchema.safeParse({ projectId: crypto.randomUUID(), mode: 'GST' }).success, false);
    assert.equal(confirmBillingModeSchema.safeParse({ projectId: crypto.randomUUID(), mode: 'gst' }).success, true);
  });

  test('who confirmed it, and how — with no value meaning “we worked it out”', () => {
    assert.match(SQL, /confirmed_by\s+uuid references core\.users\(id\)/);
    assert.match(SQL, /source\s+text not null check \(source in \('client_confirmation', 'internal'\)\)/);
    assert.match(PROSE, /Neither is an inference, which is why there is no third value for one/);
  });
});

describe('C. non-GST does not acquire GST', () => {
  test('a non-GST profile cannot hold a GSTIN at all — a constraint, not a convention', () => {
    assert.match(SQL, /constraint billing_profiles_non_gst_carries_no_gstin check \(\s*\n?\s*mode = 'gst' or gstin is null\s*\n?\s*\)/);
  });

  test('and the door refuses one by name rather than dropping it silently', () => {
    const fn = door('record_billing_details');
    assert.match(fn, /return query select 'gstin_on_non_gst'/);
    assert.match(BILLING, /This project is billed without GST, so a GSTIN is not stored against it/);
  });

  test('switching to GST does not resurrect an old GSTIN by accident', () => {
    // The mode-change insert carries the name and address forward but gates
    // the GSTIN on the new mode.
    assert.match(door('confirm_billing_mode'), /case when p_mode = 'gst' then v_live\.gstin end/);
  });

  test('readiness says non-GST is complete without one', () => {
    const r = billingReadiness({
      mode: 'non_gst',
      legal_name: 'Asha Textiles',
      billing_address: '12 MG Road',
      billing_state: 'Karnataka',
    });
    assert.equal(r.complete, true);
    assert.deepEqual([...r.missing], []);
  });
});

describe('D. incomplete GST blocks, and says exactly what is missing', () => {
  test('no mode at all blocks first, and asks for the mode', () => {
    const r = billingReadiness({ mode: null });
    assert.equal(r.complete, false);
    assert.deepEqual([...r.missing], ['billing_mode']);
  });

  test('a GST profile missing fields names them, and only them', () => {
    const r = billingReadiness({ mode: 'gst', legal_name: 'Asha Textiles' });
    assert.equal(r.complete, false);
    assert.deepEqual([...r.missing].sort(), ['billing_address', 'billing_state', 'gstin']);
  });

  test('a GSTIN that cannot be right is reported as invalid, not as missing', () => {
    const r = billingReadiness({
      mode: 'gst',
      legal_name: 'A',
      billing_address: 'B',
      billing_state: 'C',
      gstin: '27AAPFU0939F1ZX',
    });
    assert.equal(r.complete, false);
    assert.deepEqual([...r.missing], [], 'it is present — it is wrong, which is a different message');
    assert.equal(r.invalid[0]?.field, 'gstin');
    assert.match(r.invalid[0]!.reason, /check character/);
  });

  test('a complete GST profile is complete', () => {
    const r = billingReadiness({
      mode: 'gst',
      legal_name: 'Asha Textiles Pvt Ltd',
      billing_address: '12 MG Road',
      billing_state: 'Karnataka',
      gstin: '27AAPFU0939F1ZV',
    });
    assert.deepEqual({ complete: r.complete, missing: [...r.missing], invalid: [...r.invalid] }, {
      complete: true,
      missing: [],
      invalid: [],
    });
  });

  test('details before a mode are blocked at the door too', () => {
    assert.match(door('record_billing_details'), /if v_live\.id is null then\s*\n\s*return query select 'no_mode'/);
    assert.match(BILLING, /Confirm whether this project is billed with GST or without it before recording details/);
  });
});

describe('E. the GSTIN check is arithmetic, and says so', () => {
  test('the check character is reproduced for GSTINs that carry one', () => {
    // If the algorithm were wrong these would each be a 1-in-36 coincidence.
    for (const gstin of ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '24AAACC1206D1ZM', '09AAACH7409R1ZZ']) {
      assert.equal(gstinCheckCharacter(gstin.slice(0, 14)), gstin[14], gstin);
      assert.equal(checkGstin(gstin).valid, true, gstin);
    }
  });

  test('changing any single character breaks it — which is the whole point', () => {
    const base = '27AAPFU0939F1ZV';
    let caught = 0;
    for (let i = 0; i < 14; i += 1) {
      const c = base[i]!;
      const swapped = /[0-9]/.test(c) ? String((Number(c) + 1) % 10) : String.fromCharCode(((c.charCodeAt(0) - 65 + 1) % 26) + 65);
      const mutated = base.slice(0, i) + swapped + base.slice(i + 1);
      if (!checkGstin(mutated).valid) caught += 1;
    }
    assert.equal(caught, 14, 'a single-character typo went undetected');
  });

  test('length, shape and state code each fail with their own reason', () => {
    // Narrowed through `valid`, so the test asserts the refusal AND the
    // reason: reading `.reason` off an optional would pass on a verdict that
    // accepted the string.
    const why = (raw: string) => {
      const v = checkGstin(raw);
      assert.equal(v.valid, false, `${raw} was accepted`);
      return v.valid ? '' : v.reason;
    };
    assert.match(why('27AAPFU0939F1Z'), /15 characters/);
    assert.match(why('27aapfu0939f1zv!'), /15 characters|shape/);
    assert.match(why('00AAPFU0939F1ZV'), /state code/);
    assert.match(why(''), /no GSTIN/);
  });

  test('it normalises what it judges, so what is stored is what was checked', () => {
    const v = checkGstin('  27aapfu0939f1zv  ');
    assert.ok(v.valid);
    assert.equal(v.valid && v.normalized, '27AAPFU0939F1ZV');
  });

  test('it never claims the registration is real', () => {
    assert.doesNotMatch(MODULE_CODE, /verified|gstin_verified/);
    assert.match(MODULE.replace(/\n \* ?/g, ' '), /a checksum that passes is not a registration that is real/);
    // And no COLUMN is named for a check it cannot do. Asserted against the
    // column definitions rather than the whole file: the table's own comment
    // says the words `never gstin_verified`, and that sentence is the point
    // rather than a violation of it.
    const columns = SQL.slice(SQL.indexOf('create table if not exists finance.billing_profiles'), SQL.indexOf('create unique index'));
    assert.doesNotMatch(columns, /gstin_verified|verified_at|verified_by/);
    assert.match(columns, /gstin\s+text check/, 'the positive twin: the column exists, plainly named');
  });

  test('the database validates the shape, so a direct write cannot dodge it', () => {
    assert.match(SQL, /gstin\s+text check \(gstin is null or gstin ~ '\^\[0-9\]\{2\}\[A-Z\]\{5\}\[0-9\]\{4\}\[A-Z\]\[0-9A-Z\]Z\[0-9A-Z\]\$'\)/);
    // And the service checks the checksum before the write, which the database
    // deliberately does not: a check digit is arithmetic.
    assert.match(BILLING, /const verdict = checkGstin\(parsed\.data\.gstin\)/);
    assert.match(BILLING, /That GSTIN cannot be right/);
  });
});

describe('F. a version is a record', () => {
  test('details change by writing a new version, never by editing one', () => {
    const freeze = door('freeze_billing_profile');
    assert.match(freeze, /new\.mode is distinct from old\.mode/);
    assert.match(freeze, /new\.gstin is distinct from old\.gstin/);
    assert.match(freeze, /billing details change by writing a new version, never by editing one/);
  });

  test('and a superseded version is not a draft', () => {
    assert.match(door('freeze_billing_profile'), /if old\.status = 'superseded' then/);
  });

  test('one active profile per project, as an index rather than a hope', () => {
    assert.match(SQL, /create unique index if not exists billing_profiles_one_active\s*\n\s*on finance\.billing_profiles \(project_id\) where status = 'active'/);
  });

  test('re-confirming the same mode is not a new version', () => {
    // §4.3 preserves the preference "unless legitimately changed", and a
    // repeated click is not a change.
    assert.match(door('confirm_billing_mode'), /if v_live\.id is not null and v_live\.mode = p_mode then[\s\S]{0,120}'unchanged'/);
    assert.match(BILLING, /changed: outcome !== 'unchanged'/);
  });

  test('a revision that revises nothing is refused by the schema', () => {
    assert.equal(recordBillingDetailsSchema.safeParse({ projectId: crypto.randomUUID() }).success, false);
    assert.equal(
      recordBillingDetailsSchema.safeParse({ projectId: crypto.randomUUID(), legalName: 'Asha' }).success,
      true,
    );
  });
});

describe('G. what it refuses to be', () => {
  test('no tax arithmetic lives here', () => {
    assert.doesNotMatch(SQL, /tax_minor|tax_rate|1800|0\.18/);
    assert.match(PROSE, /putting a rate here would give the system two places to decide what 18% means/);
  });

  test('a failed read is not a project with no billing mode', () => {
    assert.match(BILLING, /if \(error\) return err\('INTERNAL', 'Could not read the billing profile\.'\)/);
    assert.match(BILLING_PROSE, /one blocks an invoice and asks a client a question they already answered/);
  });

  test('it carries the tenancy discipline, and no client reads it', () => {
    assert.match(SQL, /enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(SQL, /enforce_parent_org\('client_account_id', 'core\.client_accounts'\)/);
    assert.match(SQL, /alter table finance\.billing_profiles enable row level security/);
    assert.match(SQL, /alter table finance\.billing_profiles force row level security/);
    const policy = SQL.slice(SQL.indexOf('create policy billing_profiles_select'));
    assert.match(policy.slice(0, 400), /core\.is_internal\(\)/);
  });

  test('both doors are revoked from the world and granted only to a person', () => {
    for (const sig of ['confirm_billing_mode\\(uuid, text, text, text\\)', 'record_billing_details\\(uuid, text, text, text, text\\)']) {
      assert.match(SQL, new RegExp(`revoke all on function finance\\.${sig} from public`));
      assert.match(SQL, new RegExp(`grant execute on function finance\\.${sig} to authenticated;`));
      assert.doesNotMatch(SQL, new RegExp(`grant execute on function finance\\.${sig} to authenticated, service_role`));
    }
  });

  test('the event Finance §4.1 consumes is declared before it is emitted', () => {
    assert.match(SQL, /\('project\.billing_mode_confirmed'/);
    assert.match(SQL, /emit_event\([\s\S]{0,120}'project\.billing_mode_confirmed'/);
  });
});
