import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { HELP, helpHref, resolveScreen, searchScreens } from '../src/lib/help/screens.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Bucket E, decision E3 (owner, 2026-09-30): a person owns their preferences,
 * and the panel explains itself.
 *
 * Four promises, each of which erodes silently without a test naming it:
 *   1. core.user_preferences is the person's, not the tenant's — own-row RLS,
 *      no organization_id.
 *   2. The timezone is validated against pg_timezone_names, by trigger and
 *      by door, so a direct write cannot store a zone the door refuses.
 *   3. src/lib/help/screens.json is not older than the inventory it was
 *      generated from.
 *   4. /help lists every SCR id the inventory has — no screen is missing
 *      from the page that says what screens exist.
 */

const MIGRATION = 'supabase/migrations/20260930150000_a_person_has_preferences_and_the_panel_explains_itself.sql';
const INVENTORY = 'docs/AGENCYOS_ADMIN_MASTER_SCREEN_INVENTORY.md';

const migration = read(MIGRATION);
const executable = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

function region(sql: string, from: string, to: string): string {
  const start = sql.indexOf(from);
  assert.ok(start >= 0, `${from} is missing`);
  const end = sql.indexOf(to, start + from.length);
  return end >= 0 ? sql.slice(start, end) : sql.slice(start);
}

describe('1. preferences follow the person', () => {
  const table = region(executable, 'create table if not exists core.user_preferences', ');');

  it('user_id is the primary key and the foreign key to core.users', () => {
    assert.match(table, /user_id\s+uuid primary key references core\.users\(id\) on delete cascade/);
  });

  it('there is no organization column — and the header says why', () => {
    assert.doesNotMatch(table, /organization_id/);
    assert.match(migration, /WHY THERE IS NO organization_id/);
    assert.match(migration, /follows? the person/i);
  });

  it('RLS is enabled AND forced', () => {
    assert.match(executable, /alter table core\.user_preferences enable row level security/);
    assert.match(executable, /alter table core\.user_preferences force row level security/);
  });

  it('every policy admits exactly the person — user_id = auth.uid() — and nothing else', () => {
    const policies = [...executable.matchAll(/create policy (\w+) on core\.user_preferences([\s\S]*?);/g)];
    assert.equal(policies.length, 3, 'select, insert, update');
    for (const [, name, body] of policies) {
      assert.match(body ?? '', /user_id = \(select auth\.uid\(\)\)/, name ?? 'policy');
      assert.doesNotMatch(body ?? '', /is_internal|is_admin|is_owner|can_write|current_user_role|current_organization_id/, `${name} must not admit staff by role`);
    }
    const names = policies.map((p) => p[1]);
    assert.ok(names.some((n) => /select/.test(n!)));
    assert.ok(names.some((n) => /insert/.test(n!)));
    assert.ok(names.some((n) => /update/.test(n!)));
  });

  it('authenticated may select, insert and update; not delete', () => {
    assert.match(executable, /grant select, insert, update on core\.user_preferences to authenticated, service_role/);
    assert.doesNotMatch(executable, /grant[^;]*delete[^;]*on core\.user_preferences/);
  });

  it('the doors read auth.uid(), take no user id, and audit in the acting organisation', () => {
    for (const fn of ['core.set_own_preferences', 'core.update_own_profile']) {
      const body = region(executable, `create or replace function ${fn}(`, '$$;');
      assert.match(body, /security invoker/, `${fn} must not be definer`);
      assert.doesNotMatch(body, /p_user_id/, `${fn} takes no user id`);
      assert.match(body, /\(select auth\.uid\(\)\)/, fn);
      assert.match(body, /\(select core\.current_organization_id\(\)\)/, fn);
      assert.match(body, /perform core\.record_audit\(/, `${fn} is audited`);
      assert.match(body, /'no_organization'/, `${fn} refuses without an acting org`);
    }
    assert.match(executable, /'preferences\.updated'/);
    assert.match(executable, /'profile\.updated'/);
  });
});

describe('2. the timezone is a zone', () => {
  it('a trigger validates through core.is_known_timezone (pg_timezone_names)', () => {
    assert.match(executable, /create or replace function core\.user_preference_timezone_is_known\(\)/);
    assert.match(executable, /not core\.is_known_timezone\(new\.timezone\)/);
    assert.match(executable, /create trigger user_preferences_timezone_is_known\s+before insert or update of timezone on core\.user_preferences/);
    // The predicate itself is the one defined over pg_timezone_names.
    const predicate = read('supabase/migrations/20260912140000_a_meeting_is_concluded_by_a_person.sql');
    assert.match(predicate, /create or replace function core\.is_known_timezone/);
    assert.match(predicate, /pg_timezone_names/);
  });

  it('the door refuses by name before the trigger would raise', () => {
    const body = region(executable, 'create or replace function core.set_own_preferences(', '$$;');
    assert.match(body, /not core\.is_known_timezone\(v_tz\)/);
    assert.match(body, /'invalid_timezone'/);
  });

  it('null follows the organisation, and the clock resolves the person first', () => {
    const table = region(executable, 'create table if not exists core.user_preferences', ');');
    assert.match(table, /timezone\s+text,/, 'nullable, no default');
    const clock = read('src/lib/admin/agency-clock.ts');
    assert.match(clock, /export const getDisplayTimeZone = cache\(/);
    assert.match(clock, /from\('user_preferences'\)/);
    assert.match(clock, /export async function agencyClock\(timeZone\?: string\)/);
    const layout = read('app/(internal)/layout.tsx');
    assert.match(layout, /getDisplayTimeZone\(\)/, 'the internal layout resolves it once per request');
  });
});

describe('3. the help index is not older than the inventory', () => {
  const inventory = read(INVENTORY);

  /** The same rows, hashed the same way scripts/build-help.mjs hashes them. */
  function inventoryRows(markdown: string): string[] {
    const rows: string[] = [];
    let inInventory = false;
    for (const line of markdown.split('\n')) {
      if (/^## /.test(line)) {
        inInventory = /^## 1\. Inventory/.test(line);
        continue;
      }
      if (inInventory && /^\| SCR-\d{3} \|/.test(line)) rows.push(line);
    }
    return rows;
  }

  const rows = inventoryRows(inventory);
  const hash = createHash('sha256').update(rows.join('\n')).digest('hex');

  it('the JSON carries the hash of the SCR rows it was built from, and it matches', () => {
    assert.equal(HELP.source, INVENTORY);
    assert.equal(HELP.inventoryHash, hash, 'src/lib/help/screens.json is older than the inventory — run: npm run build:help');
  });

  it('one entry per SCR row, and the count says so', () => {
    assert.equal(HELP.screens.length, rows.length);
    assert.equal(HELP.count, rows.length);
  });

  it('the generator is wired as an npm script', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts['build:help'], 'node scripts/build-help.mjs');
  });
});

describe('4. /help lists every screen', () => {
  const inventory = read(INVENTORY);
  const ids = [...inventory.matchAll(/^\| (SCR-\d{3}) \|/gm)].map((m) => m[1]!);

  it('every SCR id in the inventory is an entry with a title, a route, a capability and a status', () => {
    const byId = new Map(HELP.screens.map((s) => [s.id, s]));
    for (const id of new Set(ids)) {
      const entry = byId.get(id);
      assert.ok(entry, `${id} is missing from screens.json`);
      assert.ok(entry.title.length > 0, `${id} has no title`);
      assert.ok(entry.route.length > 0, `${id} has no route`);
      assert.ok(entry.capability.length > 0, `${id} has no capability`);
      assert.ok(entry.status.length > 0, `${id} has no status`);
      assert.ok(entry.module.length > 0, `${id} has no module`);
    }
    assert.equal(new Set(ids).size, 72, 'the 71-screen baseline plus SCR-072 Contracts (owner decision 10)');
  });

  it('the page renders the generated list and the search box, and the shell links to it', () => {
    const page = read('app/(internal)/help/page.tsx');
    assert.match(page, /HELP\.screens/);
    assert.match(page, /<HelpSearch/);
    const search = read('app/(internal)/help/help-search.tsx');
    assert.match(search, /'use client'/);
    assert.match(search, /searchScreens\(/);
    const layout = read('app/(internal)/layout.tsx');
    assert.match(layout, /<HelpLink \/>/);
    assert.doesNotMatch(layout, /HelpMenu/, 'the "?" is the Help link now, not a menu');
    const menu = read('app/(internal)/shell-controls.tsx');
    assert.match(menu, /href="\/profile"/, 'the user menu carries Profile');
  });

  it('the "?" resolves the current route to its entry', () => {
    assert.equal(resolveScreen('/dashboard')?.id, 'SCR-001');
    assert.equal(resolveScreen('/leads/8c1f2a0e-0000-4000-8000-000000000000')?.id, 'SCR-007');
    assert.equal(resolveScreen('/projects/x/design/themes')?.id, 'SCR-033');
    assert.equal(resolveScreen('/projects/x/development/tasks/y')?.id, 'SCR-039');
    assert.equal(resolveScreen('/invoices/abc')?.id, 'SCR-052');
    assert.equal(resolveScreen('/settings/communication')?.id, 'SCR-059');
    assert.equal(resolveScreen('/help'), null);
    assert.equal(resolveScreen('/profile'), null);
    assert.equal(helpHref(resolveScreen('/audit')), '/help#scr-069');
    assert.equal(helpHref(null), '/help');
  });

  it('search matches on id, route and capability; empty matches all', () => {
    assert.equal(searchScreens('').length, HELP.screens.length);
    assert.ok(searchScreens('SCR-052').every((s) => s.id === 'SCR-052'));
    assert.ok(searchScreens('/invoices').some((s) => s.id === 'SCR-051'));
    assert.ok(searchScreens('audit.read').every((s) => s.capability.includes('audit.read')));
    assert.deepEqual(searchScreens('no such screen anywhere zzz'), []);
  });
});
