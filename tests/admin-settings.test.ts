import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { isValidTimeZone } from '../src/lib/admin/timezone.ts';

/**
 * The timezone setter's gatekeeper. It is the first line before the write, and
 * the same answer the database's IANA CHECK gives one layer down — so it must
 * accept exactly the zones the runtime (and Postgres) recognise, and refuse the
 * malformed input that would otherwise reach the database as an error.
 */
describe('isValidTimeZone', () => {
  test('accepts real IANA zones', () => {
    for (const z of ['Asia/Kolkata', 'Europe/London', 'America/New_York', 'UTC']) {
      assert.equal(isValidTimeZone(z), true, `${z} is valid`);
    }
  });

  test('trims surrounding whitespace', () => {
    assert.equal(isValidTimeZone('  Asia/Kolkata  '), true);
  });

  test('refuses malformed or empty input', () => {
    for (const z of ['', '   ', 'Not A Zone!', 'Mars/Olympus', 'Asia/Nowhere']) {
      assert.equal(isValidTimeZone(z), false, `${JSON.stringify(z)} is invalid`);
    }
  });
});

/**
 * The agency's own name — G-160. The letterhead on every quotation PDF read
 * "Demo Agency" one step before the first real client, and nothing but SQL
 * could change it. The database halves (owner-only, audit, the sidestep
 * guard) are proved live in verify-organization-settings §9; what is here is
 * the service's join to that door and the form's existence.
 */
describe('the agency signs its own name', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  test('the service writes through the audited setter, never a direct update', () => {
    const settings = read('../src/lib/admin/settings.ts');
    const fn = settings.slice(settings.indexOf('export async function setOrganizationName'));
    assert.match(fn, /rpc\('set_organization_name'/);
    assert.ok(
      !/\.update\(\{ name/.test(fn),
      'a direct name update appeared — the audit trail would be sidestepped',
    );
    assert.match(fn, /between 1 and 120 characters/);
  });

  test('the form exists on the settings page, wired to its action', () => {
    const forms = read('../app/(internal)/settings/forms.tsx');
    assert.match(forms, /export function OrganizationNameForm/);
    assert.match(forms, /setOrganizationNameAction/);
    const page = read('../app/(internal)/settings/page.tsx');
    assert.match(page, /<OrganizationNameForm current=\{organizationName\} \/>/);
    assert.match(page, /Agency name/);
  });

  test('the migration holds both halves: the setter audits, the guard refuses the sidestep', () => {
    const migration = read('../supabase/migrations/20260823250000_the_agency_signs_its_own_name.sql');
    assert.match(migration, /organization\.renamed/);
    assert.match(migration, /core\.is_owner\(\)/);
    assert.match(migration, /name_write_is_sanctioned/);
    assert.match(migration, /create trigger name_write_is_sanctioned/);
  });
});
