import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region } from './_region.ts';
import {
  effectiveCapabilitiesFor,
  canEffective,
  can,
  capabilitiesFor,
  CAPABILITIES,
} from '../src/lib/authz/permissions.ts';
import { ROLES } from '../src/lib/auth/claims.ts';

/**
 * A person can hold more than one role — multirole, G-310.
 *
 * Every membership has always carried exactly one role, read once into the
 * session JWT and checked by every RLS policy and every existing
 * `can(role, capability)` call. This is additive on top of that, not a
 * replacement: an owner may grant a membership one or more secondary roles
 * (`core.membership_roles`), and a NEW set of functions
 * (`effectiveCapabilitiesFor`, `canEffective`) compute the union for callers
 * that explicitly opt in. `can`, `canAll`, `canAny` and `capabilitiesFor` are
 * untouched, and every existing call site keeps checking a single role
 * exactly as it did before this file existed.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260920190000_a_person_can_hold_more_than_one_role.sql');
const SETTINGS = read('src/lib/admin/settings.ts');
const ACTIONS = read('app/(internal)/settings/actions.ts');
const PANEL = read('app/(internal)/settings/member-roles-panel.tsx');
const PAGE = read('app/(internal)/settings/team/page.tsx');
const QUERIES = read('src/modules/projects/queries.ts');

const grantDoor = region(MIGRATION, 'create or replace function core.grant_secondary_role', '$$;');
const revokeDoor = region(MIGRATION, 'create or replace function core.revoke_secondary_role', '$$;');

describe('A. the union is additive — nothing single-role changes', () => {
  test('every existing role still resolves the same capabilities alone', () => {
    for (const role of ROLES) {
      const single = new Set(capabilitiesFor(role));
      const effective = effectiveCapabilitiesFor(role, []);
      assert.deepEqual([...effective].sort(), [...single].sort(), `${role} drifted with no secondary roles`);
    }
  });

  test('a secondary role only ever ADDS capabilities, never removes any', () => {
    const primaryOnly = capabilitiesFor('member');
    const withSecondary = effectiveCapabilitiesFor('member', ['ops_admin']);
    for (const capability of primaryOnly) {
      assert.ok(withSecondary.has(capability), `${capability} was lost by adding a secondary role`);
    }
  });

  test('the union actually reaches capabilities the primary role alone does not have', () => {
    // member alone cannot issue invoices; ops_admin can. The union must.
    assert.equal(can('member', 'invoice.issue'), false);
    assert.equal(canEffective('member', ['ops_admin'], 'invoice.issue'), true);
  });

  test('an owner primary role already holds everything, union or not', () => {
    const effective = effectiveCapabilitiesFor('owner', ['member']);
    assert.deepEqual([...effective].sort(), [...CAPABILITIES].sort());
  });

  test('no secondary role and no primary role is the empty set, not a throw', () => {
    assert.deepEqual([...effectiveCapabilitiesFor(undefined, [])], []);
    assert.equal(canEffective(undefined, [], 'lead.read'), false);
  });
});

describe('A2. the roster read survives the migration not being deployed yet', () => {
  // App code deploys on merge; the migration that creates
  // core.list_membership_roles is a separate, manually-run production step
  // (ADM-20/60). A real production incident: merging this feature took down
  // the WHOLE settings page — not just the new panel — because the roster
  // reader threw on the very first request after the code deployed and
  // before the migration had been run. Every other reader on that page
  // (timezone, WhatsApp config, pricing) has nothing to do with roles.
  const reader = region(QUERIES, 'export async function listInternalRosterWithRoles');

  test('a missing-function error (PGRST202/42883) degrades, it does not throw', () => {
    // The `if` branch for the two missing-function codes logs and falls
    // through; only the `else` branch (any OTHER failure) throws. Captured
    // as the text between the condition and the `} else {` that follows it,
    // so a call to unreadable() added to the wrong branch fails this test.
    const ifBranch = region(reader, "if (code === 'PGRST202' || code === '42883') {", '} else {');
    assert.doesNotMatch(ifBranch, /unreadable\(/);
    assert.match(ifBranch, /console\.error/);
  });

  test('any OTHER failure on that read still fails loud, per G-054', () => {
    assert.match(reader, /\} else \{\s*\n\s*unreadable\('listInternalRosterWithRoles\.roles', roleError\);/);
  });

  test('the degraded case is logged, not silently swallowed', () => {
    assert.match(reader, /is not deployed to this database yet/);
  });
});

describe('B. the grant door refuses redundancy and forgery', () => {
  test('granting the membership’s own primary role is refused, not stored', () => {
    assert.match(grantDoor, /if v_target\.role = p_role then/);
    assert.match(grantDoor, /'already_primary'::text/);
  });

  test('an unrecognised role name is refused before any write', () => {
    assert.match(
      grantDoor,
      /if p_role not in \('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor'\) then/,
    );
  });

  test('only an owner may grant, checked in the database, not only in the app', () => {
    assert.match(grantDoor, /security definer/);
    assert.match(grantDoor, /if not coalesce\(\(select core\.is_owner\(\)\), false\) then/);
    assert.match(grantDoor, /'not_owner'::text/);
  });

  test('a membership outside the caller’s own organisation cannot be targeted', () => {
    assert.match(grantDoor, /where m\.id = p_membership_id and m\.organization_id = v_org/);
  });

  test('a repeat grant answers already_granted rather than a constraint error', () => {
    assert.match(grantDoor, /on conflict \(membership_id, role\) do nothing/);
    assert.match(grantDoor, /'already_granted'::text/);
  });

  test('every grant is audited', () => {
    assert.match(grantDoor, /'membership\.secondary_role_granted'/);
  });
});

describe('C. the revoke door is equally owner-gated and tells the truth about no-ops', () => {
  test('owner only, checked in the database', () => {
    assert.match(revokeDoor, /security definer/);
    assert.match(revokeDoor, /if not coalesce\(\(select core\.is_owner\(\)\), false\) then/);
  });

  test('revoking something never granted says so rather than pretending success', () => {
    assert.match(revokeDoor, /if v_rows = 0 then/);
    assert.match(revokeDoor, /'not_granted'::text/);
  });

  test('every revoke is audited', () => {
    assert.match(revokeDoor, /'membership\.secondary_role_revoked'/);
  });
});

describe('D. the schema keeps the tenancy discipline every org-scoped child follows', () => {
  test('the membership foreign key is org-guarded, same as the other 62+ relationships', () => {
    assert.match(
      MIGRATION,
      /execute function core\.enforce_parent_org\('membership_id', 'core\.memberships'\)/,
    );
  });

  test('organization_id is frozen against UPDATE', () => {
    assert.match(MIGRATION, /create trigger freeze_org_membership_roles/);
  });

  test('RLS is enabled and forced, with no write policy — every write goes through a door', () => {
    assert.match(MIGRATION, /alter table core\.membership_roles enable row level security;/);
    assert.match(MIGRATION, /alter table core\.membership_roles force row level security;/);
    assert.match(MIGRATION, /create policy membership_roles_select/);
    assert.doesNotMatch(MIGRATION, /create policy membership_roles_(insert|update|delete|write)/);
  });

  test('only the five internal roles are grantable — client roles are explicitly out of scope', () => {
    assert.match(
      MIGRATION,
      /role\s+text not null check \(role in\s*\n\s*\('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor'\)\)/,
    );
  });
});

describe('E. the limit is stated, not left to be discovered', () => {
  test('the migration says plainly this does not reach RLS', () => {
    assert.match(
      MIGRATION,
      /because RLS still reads only the primary role from the JWT/,
    );
  });

  test('the admin panel repeats the same limit in the words a person reads', () => {
    assert.match(PANEL, /does not widen which database rows they can read or write/);
  });
});

describe('F. the write path is owner-gated at the application layer too (defense in depth)', () => {
  test('grantSecondaryRole checks organization.settings before calling the door', () => {
    const fn = region(SETTINGS, 'export async function grantSecondaryRole');
    assert.match(fn, /can\(context\.role, 'organization\.settings'\)/);
  });

  test('revokeSecondaryRole checks organization.settings before calling the door', () => {
    const fn = region(SETTINGS, 'export async function revokeSecondaryRole');
    assert.match(fn, /can\(context\.role, 'organization\.settings'\)/);
  });

  test('both server actions revalidate the settings page', () => {
    assert.match(ACTIONS, /grantSecondaryRoleAction[\s\S]*?revalidatePath\('\/settings'\)/);
    assert.match(ACTIONS, /revokeSecondaryRoleAction[\s\S]*?revalidatePath\('\/settings'\)/);
  });

  test('the panel is rendered on the settings page, not built and unreachable', () => {
    assert.match(PAGE, /<MemberRolesPanel members={rosterWithRoles} \/>/);
    assert.match(PAGE, /const rosterWithRoles = await listInternalRosterWithRoles\(\);/);
  });
});
