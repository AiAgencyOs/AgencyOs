import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (p: string) => readFileSync(p, 'utf8');
const migration = read('supabase/migrations/20261014400000_every_client_and_project_has_a_code_for_life.sql');

/** The live proof is scripts/verify-client-codes.mjs; this pins what the screens and the schema must keep saying. */
describe('every client and project has an identifier for life', () => {
  test('the database assigns, ignores a supplied value, and refuses an edit - on insert and on update', () => {
    assert.match(migration, /create trigger assign_client_code before insert on core\.client_accounts/);
    assert.match(migration, /new\.client_code := 'CL-' \|\| lpad\(n::text, 6, '0'\)/);
    assert.match(migration, /create trigger assign_project_code before insert on projects\.projects/);
    assert.match(migration, /new\.project_code := code \|\| '-P' \|\| lpad\(n::text, 2, '0'\)/);
    assert.match(migration, /a client code is for life and cannot be changed/);
    assert.match(migration, /a project code is for life and cannot be changed/);
    assert.match(migration, /only moves forward/);
  });

  test('numbers only ever go up (never reissued), and are unique per organization', () => {
    assert.match(migration, /last_number = core\.client_code_counters\.last_number \+ 1/);
    assert.match(migration, /unique index if not exists client_accounts_org_client_code_key on core\.client_accounts \(organization_id, client_code\)/);
    assert.match(migration, /unique index if not exists projects_org_project_code_key on projects\.projects \(organization_id, project_code\)/);
    assert.match(migration, /revoke all on core\.client_code_counters from public, anon, authenticated/);
  });

  test('what existed before is numbered oldest first, then made mandatory', () => {
    assert.match(migration, /order by organization_id, created_at, id/);
    assert.match(migration, /alter column client_code set not null/);
    assert.match(migration, /alter column project_code set not null/);
  });

  test('the codes are SHOWN: client list and page, project list and header - and FOUND by search', () => {
    assert.match(read('app/(internal)/clients/page.tsx'), /\{c\.clientCode\}/);
    assert.match(read('app/(internal)/clients/[clientId]/page.tsx'), /label: 'Client ID'/);
    assert.match(read('app/(internal)/projects/page.tsx'), /\{p\.project_code\}/);
    assert.match(read('app/(internal)/projects/[projectId]/workspace-header.tsx'), /label: 'Project ID'/);
    assert.match(read('app/(internal)/projects/[projectId]/page.tsx'), /label: 'Project ID'/);
    assert.match(read('src/modules/projects/queries.ts'), /ilikeAny\(\['name', 'code', 'project_code'\], q\)/);
    assert.match(read('src/lib/admin/global-search.ts'), /ilikeAny\(\['name', 'client_code'\]/);
    assert.match(read('src/lib/admin/global-search.ts'), /ilikeAny\(\['name', 'project_code'\]/);
  });
});
