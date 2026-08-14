import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * A list the Admin can change — gap G-113, decision ADM-80.
 *
 * ADM-73 granted the principle and withheld implementation until the shape was
 * reviewed. This is that shape, and its defining property is how *small* it
 * is: on inspection, three of the five things a template system usually needs
 * already worked, and only the default list was unreachable.
 *
 * So most of these tests pin things that must **not** have appeared — a
 * project type, a service category, a retroactive rewrite — because the risk
 * in a configurability change is that it grows a taxonomy nobody asked for.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260814120012_a_list_the_admin_can_change.sql');
const consentMigration = read('../supabase/migrations/20260814120008_no_consent_no_send.sql');
const onboarding = read('../scripts/verify-onboarding.mjs');
/**
 * The SQL only — `--` comments *and* `comment on … is '…'` bodies removed.
 * This file documents itself in both, and the absence assertions below would
 * otherwise find the documentation and fail on it.
 */
const code = sqlCode(migration);
void codeOnly;

describe('A. no project type, and no service categories', () => {
  test('nothing reintroduces a project type', () => {
    // ADM-73 established that project type is the wrong axis. The risk in a
    // configurability change is that it grows one back.
    assert.ok(!/project_type|service_type|category|variant|template_kind/i.test(code),
      'a type or category axis was reintroduced');
  });

  test('and no closed list of services was invented', () => {
    // One baseline per organization, edited directly. An agency wanting a
    // different checklist marks items not_applicable, which already worked.
    assert.ok(!/check \(\s*kind in|check \(\s*service/i.test(code), 'a closed service list appeared');
  });
});

describe('B. the seventeen survive', () => {
  test('every original key is still in the default list', () => {
    for (const key of [
      'client_identity_confirmed', 'accepted_quotation_confirmed', 'commercial_terms_confirmed',
      'payment_verified', 'project_name_confirmed', 'requirements_imported', 'scope_version_created',
      'timeline_assumptions_recorded', 'stakeholders_identified', 'assets_requested',
      'design_references_requested', 'technical_access_identified', 'whatsapp_group_mapped',
      'project_manager_assigned', 'specialist_agents_assigned', 'kickoff_sent', 'project_activated',
    ]) {
      assert.ok(code.includes(`'${key}'`), `the default baseline lost: ${key}`);
    }
  });

  test('and every organization that already exists gets them', () => {
    // No deployment loses its checklist to this change.
    assert.match(code, /select projects\.install_default_onboarding_baseline\(o\.id\) from core\.organizations o/);
  });

  test('as does every organization created afterwards', () => {
    assert.match(migration, /create trigger install_baseline_for_new_org\s*\n\s*after insert on core\.organizations/);
  });
});

describe('C. a baseline change never rewrites a project', () => {
  test('the seeder only ever inserts, and only for one project', () => {
    // A project's checklist is a record of what that project was asked to do.
    // Editing the baseline must not make a delivered project retroactively
    // incomplete, nor erase evidence that somebody did the work.
    const seeder = code.slice(code.indexOf('function projects.seed_onboarding'));
    assert.ok(!/update projects\.onboarding_items/.test(seeder), 'the seeder rewrites existing items');
    assert.ok(!/delete from projects\.onboarding_items/.test(seeder), 'the seeder deletes existing items');
  });

  test('nothing anywhere back-applies the baseline to existing projects', () => {
    assert.ok(
      !/update projects\.onboarding_items[\s\S]{0,200}onboarding_baseline/.test(code),
      'a baseline edit propagates into projects that already have a checklist',
    );
  });

  test('and the seeder stays idempotent by item count', () => {
    // A rule that already existed: an item somebody deleted must not be
    // silently reinstated by a re-run.
    assert.match(code, /if v_existing > 0 then/);
  });

  test('the live script proves it rather than asserting it', () => {
    assert.match(onboarding, /a baseline edit never rewrites history/);
  });
});

describe('D. retiring is not deleting', () => {
  test('an item can be deactivated', () => {
    // A deleted row loses the fact that the item ever existed, which makes an
    // old project's checklist read as though somebody invented an item that
    // was never on the list.
    assert.match(code, /is_active\s+boolean not null default true/);
    assert.match(code, /and b\.is_active/);
  });
});

describe('E. the Admin owns it, and one tenant cannot see another', () => {
  test('writes require is_admin', () => {
    // The gap's own words: "so an Admin cannot configure it".
    assert.match(migration, /create policy onboarding_baseline_write[\s\S]{0,300}core\.is_admin\(\)/);
  });

  test('reads are internal, never client', () => {
    assert.ok(!/is_client\(\)/.test(migration), 'a client can read the baseline');
    assert.match(migration, /create policy onboarding_baseline_select[\s\S]{0,300}core\.is_internal\(\)/);
  });

  test('RLS is enabled and every policy is organization-scoped', () => {
    assert.match(migration, /alter table projects\.onboarding_baseline enable row level security/);
    const policies = [...migration.matchAll(/create policy onboarding_baseline_\w+[\s\S]*?;/g)].map((m) => m[0]);
    assert.equal(policies.length, 2, `expected two policies, found ${policies.length}`);
    for (const p of policies) {
      assert.match(p, /organization_id = \(select core\.current_organization_id\(\)\)/);
    }
  });

  test('and a key is unique per organization, not globally', () => {
    // Global uniqueness would let one tenant's key collide with another's.
    assert.match(code, /unique \(organization_id, key\)/);
  });
});

describe('F. changing it is on the record', () => {
  test('the table carries the audit trigger', () => {
    assert.match(migration, /create trigger record_row_change\s*\n\s*after insert or update on projects\.onboarding_baseline/);
  });

  test('and the vocabulary arrives in the same change', () => {
    // `audit.record_row_change` raises for any table it has no vocabulary for.
    assert.match(code, /when 'onboarding_baseline' then/);
    for (const action of ['added', 'retired', 'restored', 'updated']) {
      assert.ok(code.includes(`'onboarding_baseline.${action}'`), `no audit action for ${action}`);
    }
  });

  test('the audit function was regenerated whole, not from an older copy', () => {
    // An earlier change here regenerated this same function from a stale copy
    // and silently dropped the `proposals` branch, which would have broken
    // every proposal write while every gate stayed green.
    //
    // Compared by splicing out the one contiguous block this change adds: the
    // remainder must be identical to the previous copy, line for line. A first
    // draft compared line *sets* with occurrence counts, which was clever,
    // fragile, and wrong about `case` and `end;` appearing legitimately
    // elsewhere.
    const linesOf = (sql: string) => {
      const i = sql.indexOf('create or replace function audit.record_row_change');
      return sql
        .slice(i, sql.indexOf('$$;', i))
        .split('\n')
        .map((l) => l.replace(/--.*$/, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    };

    const mine = linesOf(migration);
    const previous = linesOf(consentMigration);

    const at = mine.indexOf("when 'onboarding_baseline' then");
    assert.ok(at > 0, 'the new branch is not in the regenerated function at all');

    const spliced = [...mine];
    spliced.splice(at, mine.length - previous.length);
    assert.deepEqual(spliced, previous);
  });
});
