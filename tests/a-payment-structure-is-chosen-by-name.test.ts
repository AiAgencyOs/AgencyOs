import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * A payment structure is chosen by name — Business Phase 1-4 audit step 1.28.
 *
 * These pin the structure the live verification in
 * `scripts/verify-discount-and-payment-structure-local.sql` drives against a
 * real Postgres: the closed vocabulary, one active structure per kind, and
 * that a negotiation can only ever select a name the owner already
 * authorised — never invent milestones.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION_RAW = read('supabase/migrations/20260929110000_a_payment_structure_is_chosen_by_name.sql');
const MIGRATION = sqlCode(MIGRATION_RAW);
const SCHEMA = read('src/modules/sales/schema.ts');
const SERVICE = read('src/modules/sales/service.ts');

const KIND_LIST = "'standard', 'lower_advance', 'prototype_first', 'split', 'deferral'";

describe('A. the closed vocabulary lives in DDL', () => {
  test('the kind column is a CHECK against the five named kinds, nullable for every existing structure', () => {
    assert.match(
      MIGRATION,
      /add column if not exists kind text\s*check \(kind is null or kind in \(\s*'standard', 'lower_advance', 'prototype_first', 'split', 'deferral'\s*\)\);/,
    );
  });

  test('one active structure per kind per organization', () => {
    assert.match(
      MIGRATION,
      /create unique index if not exists payment_structures_active_kind_key\s*on sales\.payment_structures \(organization_id, kind\)\s*where active and kind is not null;/,
    );
  });

  test('none of the five is seeded — an owner authors it or the corpus defaults stand', () => {
    // The only INSERT into payment_structures is inside set_payment_structure
    // itself (the owner's own door); there is no top-level seed row for any
    // of the five kinds.
    assert.doesNotMatch(MIGRATION_RAW, /^insert into sales\.payment_structures/m);
  });
});

describe('B. authoring names a kind, additively', () => {
  test('the old five-argument set_payment_structure is dropped explicitly first', () => {
    assert.match(MIGRATION, /drop function if exists sales\.set_payment_structure\(uuid, text, jsonb, bigint, bigint\);/);
  });

  test('an invalid kind is refused by the function, not silently written', () => {
    assert.match(MIGRATION, /if p_kind is not null and p_kind not in \(\s*'standard', 'lower_advance', 'prototype_first', 'split', 'deferral'\s*\) then\s*return query select 'invalid_kind'::text, null::uuid;/);
  });

  test('a second structure cannot claim a kind that is already active under a different name', () => {
    assert.match(MIGRATION, /return query select 'kind_already_active'::text, null::uuid;/);
  });
});

describe('C. applying one never invents a schedule', () => {
  test('apply_payment_structure_kind selects the ONE active structure of that kind, never a list', () => {
    assert.match(
      MIGRATION,
      /select s\.\* into v_structure\s*from sales\.payment_structures s\s*where s\.organization_id = v_row\.organization_id\s*and s\.kind = p_kind\s*and s\.active;/,
    );
  });

  test('no structure of that kind is a named refusal, not a fabricated schedule', () => {
    assert.match(MIGRATION, /return query select 'no_structure_of_kind'::text, null::uuid, null::text;/);
  });

  test('it only ever operates on a DRAFT quotation', () => {
    assert.match(MIGRATION, /if v_row\.status <> 'draft' then\s*return query select 'not_draft'::text/);
  });

  test('it writes document.paymentStructure in the exact shape quotation-standards.ts already reads', () => {
    assert.match(
      MIGRATION,
      /'paymentStructure',\s*jsonb_build_object\(\s*'name',\s*v_structure\.name,\s*'milestones',\s*v_milestones\s*\)/,
    );
  });
});

describe('D. the TypeScript surface exposes only the closed vocabulary', () => {
  test('PAYMENT_STRUCTURE_KINDS matches the DDL list exactly', () => {
    assert.match(
      SCHEMA,
      /export const PAYMENT_STRUCTURE_KINDS = \[\s*'standard',\s*'lower_advance',\s*'prototype_first',\s*'split',\s*'deferral',\s*\] as const;/,
    );
  });

  test('applyPaymentStructureKindSchema accepts only a kind, never a milestone list', () => {
    const match = SCHEMA.match(/export const applyPaymentStructureKindSchema = z\.object\(\{([\s\S]{0,200}?)\}\);/);
    assert.ok(match, 'applyPaymentStructureKindSchema not found');
    const body = match![1]!;
    assert.match(body, /kind: z\.enum\(PAYMENT_STRUCTURE_KINDS\)/);
    assert.doesNotMatch(body, /milestone/i);
  });

  test('applyPaymentStructureKind is exported from service.ts', () => {
    assert.match(SERVICE, /export async function applyPaymentStructureKind\(/);
  });
});

describe(`E. the five names are Doc 07's vocabulary (${KIND_LIST}), not invented here`, () => {
  test('the migration says so, rather than leaving the reader to guess', () => {
    assert.match(MIGRATION_RAW, /Doc 07's own vocabulary/);
  });
});
