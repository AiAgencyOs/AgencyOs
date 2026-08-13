import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { INVOICE_TRANSITIONS } from '../src/modules/finance/schema.ts';

/**
 * Refunds — gap G-005.
 *
 * The behaviour is proved against a real database by
 * `scripts/verify-refunds.mjs`, where every rule is a lock-scoped decision
 * about money. What is pinned here is that the three rules it enforces were
 * already written down elsewhere, and that none of them can be softened
 * without this failing.
 */

const migration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260813120008_refunds.sql', import.meta.url)),
  'utf8',
);

const engine = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260812120011_approval_engine.sql', import.meta.url)),
  'utf8',
);

describe('A. the rules already existed', () => {
  test('the approval engine has carried `refund` as a subject type since it landed', () => {
    assert.match(engine, /'invoice', 'refund'/);
  });

  test('and its money floor already refused any refund policy below owner', () => {
    assert.match(engine, /when subject_type = 'refund'\s+then required_role = 'owner'/);
  });

  test('`paid` was already terminal, so a refund cannot be a status flip', () => {
    assert.deepEqual(
      INVOICE_TRANSITIONS.paid,
      [],
      'if paid ever gains an outgoing transition, this design needs rethinking',
    );
  });
});

describe('B. nothing leaves without an approval', () => {
  test('recording checks the approval state and refuses anything but approved', () => {
    assert.match(migration, /if v_state is distinct from 'approved' then/);
    assert.match(migration, /'not_approved'::text/);
  });

  test('and there is no write policy, so the functions cannot be bypassed', () => {
    assert.ok(
      !/create policy \w+ on finance\.refunds\s+for (all|insert|update)/.test(migration),
      'a write policy here would let a refund be recorded with no approval behind it',
    );
    assert.match(migration, /No write policy/);
  });
});

describe('C. it cannot exceed what came in', () => {
  test('the ceiling is computed under the invoice’s lock', () => {
    const fn = migration.slice(migration.indexOf('function finance.request_refund'));
    assert.ok(
      fn.indexOf('for update') < fn.indexOf('net_received_minor'),
      'measuring before locking is the race D1 was',
    );
  });

  test('requests still waiting count against it', () => {
    // Otherwise three people each request the full amount, all three are
    // approved, and the ceiling is only discovered on the third recording —
    // after two owners have already said yes to money that is not there.
    assert.match(
      migration,
      /where r\.invoice_id = p_invoice_id and r\.status = 'requested'/,
      'a waiting request must be subtracted from the ceiling',
    );
  });

  test('it refuses rather than clamping', () => {
    assert.match(migration, /'exceeds_received'::text/);
    assert.ok(!/least\(p_amount_minor/.test(migration), 'a clamp appeared where a refusal belongs');
  });

  test('and the ceiling is re-checked when the money actually leaves', () => {
    const fn = migration.slice(migration.indexOf('function finance.record_refund'));
    assert.match(fn.slice(0, 3000), /net_received_minor/);
    assert.match(fn.slice(0, 3000), /an approval approved yesterday must still fit today|still fit today/);
  });
});

describe('D. recording is idempotent', () => {
  test('the same bank reference twice is one refund', () => {
    assert.match(migration, /refunds_provider_key/);
    assert.match(migration, /'duplicate'::text/);
  });

  test('and a refund already recorded is not recorded again', () => {
    assert.match(migration, /'already_recorded'::text/);
  });
});
