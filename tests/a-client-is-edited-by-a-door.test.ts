import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { updateClientAccountSchema } from '../src/lib/admin/client-edit-schema.ts';
import { checkGstin, gstinCheckCharacter } from '../src/modules/finance/gstin.ts';
import { sqlCode } from './_code-only.ts';
import { region } from './_region.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * A client is edited by a door — bucket F-B, SCR-014/015.
 *
 * `core.client_accounts` gains a legal name, a GSTIN, a PAN and a billing
 * address, and ONE function writes them: `core.update_client_account`,
 * which checks the GSTIN's shape, state code and check character, the
 * PAN's shape, and that a GSTIN and PAN given together agree — then
 * audits. The assigned team (`core.client_account_members`) is set whole
 * by a second door. Nothing in the application updates those columns
 * directly.
 */

const MIGRATION = read('supabase/migrations/20261001110000_a_lead_is_scored_by_two_and_a_client_is_edited.sql');
const CODE = sqlCode(MIGRATION);

describe('A. the columns and their shape constraints', () => {
  test('four columns are added, with shape checks for GSTIN and PAN and agreement between them', () => {
    assert.match(CODE, /alter table core\.client_accounts\s+add column if not exists legal_name\s+text,\s+add column if not exists gstin\s+text,\s+add column if not exists pan\s+text,\s+add column if not exists billing_address text/);
    assert.match(CODE, /add constraint client_accounts_gstin_shape\s+check \(gstin is null or gstin ~ '\^\[0-9\]\{2\}\[A-Z\]\{5\}\[0-9\]\{4\}\[A-Z\]\[0-9A-Z\]Z\[0-9A-Z\]\$'\)/);
    assert.match(CODE, /add constraint client_accounts_pan_shape\s+check \(pan is null or pan ~ '\^\[A-Z\]\{5\}\[0-9\]\{4\}\[A-Z\]\$'\)/);
    assert.match(CODE, /add constraint client_accounts_gstin_carries_pan\s+check \(gstin is null or pan is null or substr\(gstin, 3, 10\) = pan\)/);
  });
});

describe('B. the door checks the checksum, and it agrees with the TypeScript reference', () => {
  const door = region(MIGRATION, 'create or replace function core.update_client_account');

  test('security invoker, internal only, audited by name', () => {
    assert.match(door, /security invoker/);
    assert.match(door, /core\.is_internal\(\)/);
    assert.match(door, /perform core\.record_audit\(v_org, 'client_account\.details_updated', 'client_account', p_client_account_id, v_before, v_after\)/);
  });

  test('it refuses a bad GSTIN, a bad PAN and a disagreeing pair, each by name', () => {
    assert.match(door, /core\.gstin_check_character\(substr\(v_gstin, 1, 14\)\) is distinct from substr\(v_gstin, 15, 1\)/);
    assert.match(door, /return query select 'bad_gstin'::text/);
    assert.match(door, /return query select 'bad_pan'::text/);
    assert.match(door, /return query select 'gstin_pan_mismatch'::text/);
    assert.match(door, /return query select 'no_name'::text/);
  });

  test('the SQL check character is the same arithmetic as src/modules/finance/gstin.ts', () => {
    // The published example, and two the reference computes.
    const fn = region(MIGRATION, 'create or replace function core.gstin_check_character');
    assert.match(fn, /'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'/);
    assert.match(fn, /v_prod := v_value \* \(case when v_i % 2 = 0 then 2 else 1 end\)/);
    assert.match(fn, /v_sum {2}:= v_sum \+ \(v_prod \/ 36\) \+ \(v_prod % 36\)/);
    assert.match(fn, /\(\(36 - \(v_sum % 36\)\) % 36\) \+ 1/);
    assert.equal(gstinCheckCharacter('27AAPFU0939F1Z'), 'V');
    assert.equal(checkGstin('27AAPFU0939F1ZV').valid, true);
    assert.equal(checkGstin('27AAPFU0939F1ZX').valid, false);
  });

  test('the TypeScript door goes through the function with project.write and never updates the columns itself', () => {
    const service = read('src/lib/admin/client-edit.ts');
    assert.match(service, /can\(context, 'project\.write'\)/);
    assert.match(service, /rpc\('update_client_account'/);
    assert.doesNotMatch(service, /\.update\(\{/);
    const offenders: string[] = [];
    for (const file of ['src/lib/admin/client-ownership.ts', 'src/lib/admin/clients.ts', 'src/lib/admin/client-team.ts']) {
      if (/\.update\(\s*\{[^}]*\b(legal_name|gstin|pan|billing_address)\s*:/s.test(read(file))) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  test('the schema upper-cases and shape-checks before the door is even called', () => {
    const ok = updateClientAccountSchema.safeParse({ clientAccountId: '0f7c6a4c-3a2c-4a5d-9d5e-6c5f3b3f7d1a', name: 'Acme', gstin: '27aapfu0939f1zv', pan: 'aapfu0939f' });
    assert.ok(ok.success);
    assert.equal(ok.data.gstin, '27AAPFU0939F1ZV');
    assert.equal(ok.data.pan, 'AAPFU0939F');
    assert.equal(updateClientAccountSchema.safeParse({ clientAccountId: '0f7c6a4c-3a2c-4a5d-9d5e-6c5f3b3f7d1a', name: 'Acme', gstin: 'not-a-gstin' }).success, false);
    assert.equal(updateClientAccountSchema.safeParse({ clientAccountId: '0f7c6a4c-3a2c-4a5d-9d5e-6c5f3b3f7d1a', name: '' }).success, false);
  });
});

describe('C. the assigned team is a table with the tenancy every new table carries, and one door', () => {
  test('the table: organization_id, RLS enabled AND forced, internal select, role-named write, grants, tenancy triggers', () => {
    const table = region(MIGRATION, 'create table if not exists core.client_account_members');
    assert.match(table, /organization_id {3}uuid not null references core\.organizations\(id\) on delete cascade/);
    assert.match(table, /unique \(client_account_id, user_id\)/);
    assert.match(CODE, /alter table core\.client_account_members enable row level security/);
    assert.match(CODE, /alter table core\.client_account_members force row level security/);
    assert.match(CODE, /create policy client_account_members_select on core\.client_account_members/);
    assert.match(CODE, /create policy client_account_members_write on core\.client_account_members/);
    assert.match(CODE, /grant select, insert, update, delete on core\.client_account_members to authenticated, service_role/);
    assert.match(CODE, /create trigger org_match_client_account_members_client/);
    assert.match(CODE, /core\.enforce_parent_org\('client_account_id', 'core\.client_accounts'\)/);
    assert.match(CODE, /create trigger freeze_org_client_account_members/);
  });

  test('the door replaces the set whole, refuses a non-member, and audits a change', () => {
    const door = region(MIGRATION, 'create or replace function core.set_client_account_team');
    assert.match(door, /security invoker/);
    assert.match(door, /m\.status = 'active'/);
    assert.match(door, /return query select 'not_a_member'::text/);
    assert.match(door, /delete from core\.client_account_members m/);
    assert.match(door, /on conflict \(client_account_id, user_id\) do nothing/);
    assert.match(door, /'client_account\.team_set'/);
  });

  test('the Settings tab mounts the edit form, the owner and tags forms, and the team multi-select', () => {
    const page = read('app/(internal)/clients/[clientId]/page.tsx');
    assert.match(page, /'settings'\] as const/);
    assert.match(page, /tab === 'settings'/);
    assert.match(page, /<ClientEditForm client=\{identity\} \/>/);
    assert.match(page, /<ClientTeamForm/);
    assert.match(page, /<ClientOwnerForm/);
    assert.match(page, /<ClientTagsForm/);
    // The list mounts the SAME edit form (bucket F rule 1).
    const list = read('app/(internal)/clients/page.tsx');
    assert.match(list, /<ClientEditButton client=/);
    const form = read('app/(internal)/clients/client-edit-form.tsx');
    assert.match(form, /updateClientAccountAction/);
  });
});
