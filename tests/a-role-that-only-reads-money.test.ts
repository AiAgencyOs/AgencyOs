import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';
import { region } from './_region.ts';

/**
 * A role that only reads money — Doc 09 §35, closing a granular gap.
 *
 * "Finance sees necessary billing info, not unrestricted sales notes" names
 * a role this repository never had: `invoice.read` was only ever held by
 * owner and ops_admin, and both of those also hold blanket internal read of
 * every lead, contact and sales note via `core.is_internal()`. There was no
 * role for which both halves of that sentence could be true at once.
 *
 * `finance` is added without touching `core.is_internal()` or any of the
 * roughly two dozen CRM/sales SELECT policies gated on it — the guarantee is
 * an omission (finance is simply not one of the five roles that predicate
 * admits), not a new narrowing of ~30 existing policies. This file proves
 * the omission is real (the predicate itself, unmodified, is what's read),
 * that the row-level grant landed only on finance.invoices/payments, and
 * that the two TypeScript lists routing the internal app shell and the
 * capability model both know about the new role.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260921120000_a_role_that_only_reads_money.sql');
const CODE = sqlCode(MIGRATION);

describe('A. finance is not one of the roles core.is_internal() admits', () => {
  test('core.is_internal() itself is not touched by this migration', () => {
    assert.doesNotMatch(MIGRATION, /create or replace function core\.is_internal/);
  });

  test('a dedicated, narrower predicate exists for finance alone', () => {
    const fn = region(MIGRATION, 'create or replace function core.is_finance()', '$$;');
    assert.match(fn, /select core\.current_user_role\(\) = 'finance';/);
  });
});

describe('B. the row-level grant lands only on finance.invoices and finance.payments', () => {
  test('invoices_select admits is_admin OR is_finance, and still admits the client half unchanged', () => {
    const policy = region(MIGRATION, 'create policy invoices_select on finance.invoices', ');');
    assert.match(policy, /\(select core\.is_admin\(\)\)/);
    assert.match(policy, /or \(select core\.is_finance\(\)\)/);
    assert.match(policy, /select core\.is_client\(\)/);
  });

  test('payments_select admits is_finance too, alongside the original owner/ops_admin and client arms', () => {
    const policy = region(MIGRATION, 'create policy payments_select on finance.payments', ');');
    assert.match(policy, /\(select core\.current_user_role\(\)\) in \('owner', 'ops_admin'\)/);
    assert.match(policy, /or \(select core\.is_finance\(\)\)/);
  });

  test('no CRM or sales table is touched by this migration at all', () => {
    assert.doesNotMatch(CODE, /crm\./);
    assert.doesNotMatch(CODE, /sales\./);
  });

  test('memberships.role widens to admit finance, and nothing is removed from the list', () => {
    assert.match(
      MIGRATION,
      /check \(role in \('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor', 'finance'\)\)/,
    );
  });

  test('finance is deliberately not added to the multirole table or its grant door', () => {
    assert.doesNotMatch(CODE, /membership_roles/);
    assert.doesNotMatch(CODE, /grant_secondary_role/);
  });
});

describe('C. the TypeScript layer knows about the role without widening what it can DO', () => {
  const CLAIMS = read('src/lib/auth/claims.ts');
  const PERMISSIONS = read('src/lib/authz/permissions.ts');

  test('finance reaches the internal app shell rather than the client portal', () => {
    assert.match(CLAIMS, /export const ROLES = \[[\s\S]*?'finance'[\s\S]*?\] as const;/);
    assert.match(CLAIMS, /export const INTERNAL_ROLES: readonly Role\[\] = \[[\s\S]*?'finance',?\s*\n\];/);
  });

  test('finance holds exactly invoice.read, nothing lead/contact/project-shaped', () => {
    const entry = region(PERMISSIONS, 'finance: [', '],');
    assert.match(entry, /'invoice\.read'/);
    assert.doesNotMatch(entry, /lead\.|contact\.|project\.|proposal\./);
  });

  test('the root redirect sends finance to /invoices, not to an empty /dashboard', () => {
    const HOME = read('app/page.tsx');
    assert.match(HOME, /if \(context\.role === 'finance'\) redirect\('\/invoices'\);/);
  });
});
