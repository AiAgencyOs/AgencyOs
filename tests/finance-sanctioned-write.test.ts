import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

// finance.invoices is writable only through its finance functions; the guard
// finance.invoices_write_is_sanctioned (20260815290000) refuses any authenticated
// direct write that does not carry the transaction-scoped finance.sanctioned_write
// flag. The five functions below are the ones an authenticated end-user calls to
// write an invoice, so each MUST set that flag as it runs, or a legitimate write
// through it will be refused. (mark_overdue_invoices is granted only to the
// service role, whose writes the guard already allows, so it is not required to.)
//
// This pins the invariant against a future regeneration that reproduces one of
// these functions and drops the line — which would silently break issuing,
// voiding, or payment reconciliation for real users while every service-role
// verify script (exempt) still passed.

const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const SANCTIONED = [
  'create_milestone_invoice',
  'issue_invoice',
  'record_manual_payment',
  'verify_payment',
  'void_invoice',
];

/** The comment-stripped body of the LAST migration that defines finance.<name>. */
function effectiveDefinition(name: string): { file: string; body: string } | null {
  const marker = `create or replace function finance.${name}(`;
  let found: { file: string; body: string } | null = null;
  for (const f of files) {
    const code = sqlCode(readFileSync(dir + f, 'utf8'));
    const idx = code.toLowerCase().indexOf(marker);
    if (idx < 0) continue;
    const rest = code.slice(idx + marker.length);
    const nextIdx = rest.toLowerCase().indexOf('create or replace function');
    found = { file: f, body: nextIdx >= 0 ? rest.slice(0, nextIdx) : rest };
  }
  return found;
}

describe('finance.invoices: every user-callable writer declares the sanctioned-write capability', () => {
  for (const name of SANCTIONED) {
    test(`finance.${name} sets finance.sanctioned_write`, () => {
      const def = effectiveDefinition(name);
      assert.ok(def, `no CREATE OR REPLACE for finance.${name} found in any migration`);
      assert.match(
        def!.body,
        /set_config\(\s*'finance\.sanctioned_write'\s*,\s*'on'\s*,\s*true\s*\)/,
        `finance.${name} (last defined in ${def?.file}) must set finance.sanctioned_write='on' as it runs, ` +
          'or the invoices guard will refuse an authenticated caller’s legitimate write through it',
      );
    });
  }

  test('the invoices guard trigger is installed', () => {
    const all = files.map((f) => sqlCode(readFileSync(dir + f, 'utf8'))).join('\n');
    assert.match(all, /create trigger invoices_write_is_sanctioned/i);
    assert.match(all, /before insert or update on finance\.invoices/i);
  });
});
