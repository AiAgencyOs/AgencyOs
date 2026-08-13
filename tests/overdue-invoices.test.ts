import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { INVOICE_TRANSITIONS, PAYABLE_INVOICE_STATUSES } from '../src/modules/finance/schema.ts';

/**
 * Invoices going overdue — gap G-004.
 *
 * The rule was never missing. `overdue` has been in the status vocabulary and
 * in `INVOICE_TRANSITIONS` since the schema was written, and nothing performed
 * it — so this is an existing rule executed rather than a new one invented,
 * and these tests pin that correspondence.
 *
 * The behaviour is proved against a real database by
 * `scripts/verify-overdue-invoices.mjs`, where most of the value is in the
 * five statuses it must leave alone.
 */

const migration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260813120007_overdue_invoices.sql', import.meta.url)),
  'utf8',
);

describe('A. the transition already existed', () => {
  test('the state machine has always admitted issued → overdue', () => {
    assert.ok(INVOICE_TRANSITIONS.issued.includes('overdue'));
    assert.ok(INVOICE_TRANSITIONS.partially_paid.includes('overdue'));
  });

  test('and the function moves exactly those two, no others', () => {
    assert.match(migration, /status in \('issued', 'partially_paid'\)/);
    assert.ok(!/status = 'draft'/.test(migration), 'a draft cannot be late — nobody has seen it');
  });

  test('overdue is still payable, so nothing is stranded by being marked', () => {
    assert.ok(
      PAYABLE_INVOICE_STATUSES.includes('overdue'),
      'marking an invoice late must not stop it being paid',
    );
  });
});

describe('B. what the sweep will not do', () => {
  test('it chases nobody — a reminder is client-facing and waits on the policy', () => {
    assert.ok(!/whatsapp|send_outbound|notify/i.test(migration.replace(/^--.*$/gm, '')));
    assert.match(migration, /It does not chase anybody/);
  });

  test('it takes the row before deciding, and restates the status on the write', () => {
    assert.match(migration, /for update skip locked/);
    const fn = migration.slice(migration.indexOf('update finance.invoices'));
    assert.match(fn.slice(0, 600), /and finance\.invoices\.status in \('issued', 'partially_paid'\)/);
  });

  test('and audits only what it actually changed', () => {
    // `if found` after the guarded update: an invoice paid in the same instant
    // is not audited as having gone overdue, because it did not.
    assert.match(migration, /if found then[\s\S]{0,200}record_audit/);
  });
});
