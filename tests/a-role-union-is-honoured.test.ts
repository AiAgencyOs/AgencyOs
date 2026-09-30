import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { visibleModulesFor } from '../app/(internal)/nav-config.ts';
import { can, canAll, canAny, capabilitiesFor, hasRole, rolesOf } from '../src/lib/authz/permissions.ts';
import { codeOnly, sqlCode } from './_code-only.ts';
import { region } from './_region.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * A role union is honoured — decision 2026-09-30 (F2): secondary roles are
 * honoured by every permission check.
 *
 * A membership carries one primary role in its JWT and may hold more
 * (`core.membership_roles`). Until this decision every `can()` in the app
 * read the primary alone, so a grant changed nothing. Now:
 *
 *   A. `can` takes the SUBJECT — a bare role, or a context whose `roles` is
 *      the union — and answers over the union; nothing single-role changes.
 *   B. `requireInternal()` loads the secondary roles into the context, and
 *      no check against a context's primary role alone survives in src/ or
 *      app/ (the structural half: a check the sweep missed is a check a
 *      granted role cannot reach).
 *   C. In the database, `core.is_owner`, `core.is_admin` and `core.can_write`
 *      consult `core.holds_role`, which reads the JWT first and the
 *      membership's secondary roles second.
 *   D. The navigation, which reads the same `can`, shows a secondary role's
 *      pages.
 */

const MEMBER_WITH_OPS = { role: 'member' as const, roles: ['member', 'ops_admin'] as const };

describe('A. can() reads the union, and nothing single-role changes', () => {
  test('a bare role answers exactly as before', () => {
    assert.equal(can('member', 'invoice.issue'), false);
    assert.equal(can('ops_admin', 'invoice.issue'), true);
    assert.equal(can(undefined, 'lead.read'), false);
  });

  test('a context with a secondary role reaches what the primary alone cannot', () => {
    assert.equal(can({ role: 'member', roles: ['member'] }, 'invoice.issue'), false);
    assert.equal(can(MEMBER_WITH_OPS, 'invoice.issue'), true);
    assert.equal(canAny(MEMBER_WITH_OPS, ['invoice.issue']), true);
    assert.equal(canAll(MEMBER_WITH_OPS, ['invoice.issue', 'lead.read']), true);
  });

  test('a secondary role only ever adds — nothing the primary grants is lost', () => {
    for (const c of capabilitiesFor('member')) assert.ok(can(MEMBER_WITH_OPS, c), `${c} lost`);
    assert.ok(capabilitiesFor(MEMBER_WITH_OPS).includes('invoice.issue'));
  });

  test('a context without `roles` is the primary alone, so a caller that never loaded them is not widened by accident', () => {
    assert.equal(can({ role: 'member' }, 'invoice.issue'), false);
    assert.deepEqual([...rolesOf({ role: 'member' })], ['member']);
  });

  test('hasRole honours a secondary owner, and the primary stays the primary', () => {
    const ctx = { role: 'ops_admin' as const, roles: ['ops_admin', 'owner'] as const };
    assert.equal(hasRole(ctx, 'owner'), true);
    assert.equal(ctx.role, 'ops_admin');
    assert.equal(hasRole({ role: 'ops_admin' }, 'owner'), false);
    assert.deepEqual([...rolesOf(ctx)], ['ops_admin', 'owner']);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('B. the session carries the union, and no primary-only check remains', () => {
  const session = read('src/lib/auth/session.ts');

  test('AuthContext has `roles`, and requireInternal loads the secondary roles into it', () => {
    assert.match(session, /roles: readonly Role\[\];/);
    const gate = region(session, 'export async function requireInternal');
    assert.match(gate, /await loadSecondaryRoles\(context\.userId, context\.organizationId\)/);
    assert.match(gate, /return \{ \.\.\.context, roles \};/);
    assert.match(session, /\.from\('membership_roles'\)/);
  });

  test('a failed read of the secondary roles degrades to the primary alone, never to a refusal of the page', () => {
    const loader = region(session, 'const loadSecondaryRoles = cache(', '});');
    assert.match(loader, /if \(error\) \{[\s\S]*?return \[\];/);
    assert.doesNotMatch(loader, /unreadable\(/);
  });

  test('no `can(x.role, …)`, `canAll(x.role, …)` or `canAny(x.role, …)` survives in src/ or app/', () => {
    const offenders: string[] = [];
    for (const file of [...walk(join(root, 'src')), ...walk(join(root, 'app'))]) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      if (/\bcan(All|Any)?\(\s*[A-Za-z_][A-Za-z0-9_]*\.role\b/.test(code)) offenders.push(file.slice(root.length));
    }
    assert.deepEqual(offenders, []);
  });

  test('no owner-only door compares the primary role alone — `hasRole` is the check', () => {
    const offenders: string[] = [];
    for (const file of [...walk(join(root, 'src')), ...walk(join(root, 'app'))]) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      if (/\.role\s*(===|!==)\s*'owner'/.test(code)) offenders.push(file.slice(root.length));
    }
    assert.deepEqual(offenders, []);
    assert.match(read('src/modules/agents/controls-service.ts'), /hasRole\(context, 'owner'\)/);
    assert.match(read('src/modules/projects/scope-unfreeze-service.ts'), /!hasRole\(context, 'owner'\)/);
  });

  test('the finance home redirect still keys on the primary role — a routing decision, not a permission', () => {
    assert.match(read('app/page.tsx'), /if \(context\.role === 'finance'\) redirect\('\/invoices'\);/);
  });
});

describe('C. the database honours the union too', () => {
  const migration = readdirSync(join(root, 'supabase/migrations'))
    .filter((f) => f.includes('a_model_is_managed_a_role_is_honoured'))
    .map((f) => read(`supabase/migrations/${f}`))
    .join('\n');

  test('the migration exists and states the decision', () => {
    assert.ok(migration, 'the migration is missing');
    assert.match(migration, /Decision 2026-09-30: secondary roles are honoured by every permission check/);
  });

  test('core.holds_role reads the JWT first, then the membership’s secondary roles, as SECURITY DEFINER', () => {
    const body = region(migration, 'create or replace function core.holds_role', '$$;');
    assert.match(body, /security definer/);
    assert.match(body, /if core\.current_user_role\(\) = p_role then\s*return true;/);
    assert.match(body, /from core\.membership_roles mr\s*join core\.memberships m on m\.id = mr\.membership_id/);
    assert.match(body, /m\.user_id = v_uid/);
    assert.match(body, /m\.status = 'active'/);
  });

  test('is_owner, is_admin and can_write consult it', () => {
    const code = sqlCode(migration);
    assert.match(region(code, 'create or replace function core.is_owner()', '$$;'), /core\.holds_role\('owner'\)/);
    assert.match(region(code, 'create or replace function core.is_admin()', '$$;'), /core\.holds_role\('ops_admin'\)/);
    assert.match(region(code, 'create or replace function core.can_write()', '$$;'), /core\.holds_role\('delivery_lead'\)/);
  });

  test('every owner or admin guard in the migration is coalesced, so a null predicate cannot open a door', () => {
    const code = sqlCode(migration);
    assert.doesNotMatch(code, /not\s+\(\s*select\s+core\.(?:is_admin|is_owner|can_write|is_internal)\s*\(/);
    assert.ok((code.match(/not coalesce\(\(select core\.is_owner\(\)\), false\)/g) ?? []).length >= 6);
  });
});

describe('D. the navigation shows a secondary role its pages', () => {
  test('a member granted ops_admin sees the AI Workforce module a member alone cannot', () => {
    const memberHrefs = visibleModulesFor('member').flatMap((m) => m.items.map((i) => i.href));
    const unionHrefs = visibleModulesFor(MEMBER_WITH_OPS).flatMap((m) => m.items.map((i) => i.href));
    assert.ok(!memberHrefs.includes('/agents'));
    assert.ok(unionHrefs.includes('/agents'));
    for (const href of memberHrefs) assert.ok(unionHrefs.includes(href), `${href} lost`);
  });

  test('the layout hands the whole context to the nav, not the primary role', () => {
    assert.match(read('app/(internal)/layout.tsx'), /visibleModulesFor\(context\)/);
  });
});
