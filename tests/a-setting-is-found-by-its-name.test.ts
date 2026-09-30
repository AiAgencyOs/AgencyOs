import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { filterCommands, type Command } from '../src/lib/admin/command-palette-eval.ts';
import { catalogueFor, groupOf, SETTINGS_CATALOGUE, SETTINGS_ENTRIES } from '../src/lib/admin/settings-catalogue.ts';
import { SECRET_SLOTS } from '../src/lib/secrets/registry.ts';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * A setting is found by its name (stream H-3).
 *
 * The ⌘K palette used to reach five Settings tabs and stop. It now searches a
 * catalogue of every organization setting the settings pages expose and every
 * key slot of the vault, each linking to the anchor of the section that holds
 * its form. These guards keep the catalogue honest: no entry names a route or
 * an anchor that is not there, no entry names a key the database would refuse,
 * and the words a person types actually find things.
 */

const routeDir = (path: string) => join('app', '(internal)', ...path.split('/').filter(Boolean));

/** The whitelist `core.set_organization_setting` enforces, from the latest migration that defines it. */
function databaseWhitelist(): Set<string> {
  const dir = join(root, 'supabase', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const definers = files.filter((f) => { const t = readFileSync(join(dir, f), 'utf8'); return /function core\.set_organization_setting\(/.test(t) && /p_key not in \(/.test(t); });
  const latest = readFileSync(join(dir, definers[definers.length - 1]!), 'utf8');
  const block = /p_key not in \(([\s\S]*?)\)\s*then/.exec(latest);
  assert.ok(block, 'the whitelist is found in the latest migration that defines the door');
  const withoutComments = block[1]!.replace(/--[^\n]*/g, '');
  return new Set([...withoutComments.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!));
}

describe('the catalogue is well formed', () => {
  it('has no duplicate keys, and every entry has a label, an anchored href and words to be found by', () => {
    const keys = SETTINGS_CATALOGUE.map((e) => e.key);
    assert.equal(new Set(keys).size, keys.length, 'a key is used twice');
    for (const e of SETTINGS_CATALOGUE) {
      assert.ok(e.label.trim().length > 0, e.key);
      assert.match(e.href, /^\/[a-z/-]+#[A-Za-z0-9_-]+$/, `${e.key} links to a page and an anchor`);
      assert.ok(e.keywords.length > 0, `${e.key} has keywords`);
    }
  });

  it('lists every key slot of the vault registry, each pointing at its own row', () => {
    for (const slot of SECRET_SLOTS) {
      const entry = SETTINGS_CATALOGUE.find((e) => e.key === `secret:${slot.key}`);
      assert.ok(entry, `${slot.key} is findable`);
      assert.equal(entry.href, `/security/keys#${slot.key}`);
      assert.equal(entry.kind, 'secret');
    }
  });
});

describe('every href resolves to a real route and a real anchor', () => {
  it('each settings entry names a page that exists and an id that page renders, once', () => {
    for (const e of SETTINGS_ENTRIES) {
      const [path, anchor] = e.href.split('#') as [string, string];
      const dir = routeDir(path);
      assert.ok(existsSync(join(root, dir, 'page.tsx')), `${e.key}: ${path} has no page`);
      const sources = readdirSync(join(root, dir))
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => read(join(dir, f)));
      const occurrences = sources.reduce((n, s) => n + s.split(`id="${anchor}"`).length - 1, 0);
      assert.equal(occurrences, 1, `${e.key}: id="${anchor}" appears ${occurrences} times under ${path}`);
    }
  });

  it('the settings pages carry no id twice', () => {
    for (const path of new Set(SETTINGS_ENTRIES.map((e) => e.href.split('#')[0]!))) {
      const source = read(join(routeDir(path), 'page.tsx'));
      const ids = [...source.matchAll(/\sid="([a-z0-9-]+)"/g)].map((m) => m[1]!);
      assert.equal(new Set(ids).size, ids.length, `${path} repeats an id`);
    }
  });

  it('the keys page gives every slot an id equal to its key', () => {
    assert.ok(existsSync(join(root, routeDir('/security/keys'), 'page.tsx')));
    assert.match(read('app/(internal)/security/keys/page.tsx'), /<li id=\{slot\.key\}/);
  });
});

describe('every settings key in the catalogue is one the database accepts', () => {
  it('org-setting entries are on the whitelist core.set_organization_setting owns', () => {
    const whitelist = databaseWhitelist();
    const named = SETTINGS_ENTRIES.filter((e) => e.kind === 'org-setting');
    assert.ok(named.length >= 15, 'the catalogue names the operational settings');
    for (const e of named) assert.ok(whitelist.has(e.key), `${e.key} is not on the database whitelist`);
  });

  it('section entries do not borrow a whitelisted key as their slug', () => {
    const whitelist = databaseWhitelist();
    for (const e of SETTINGS_ENTRIES.filter((x) => x.kind === 'section')) assert.ok(!whitelist.has(e.key), e.key);
  });
});

describe('the palette finds a setting by what a person types', () => {
  const commands: Command[] = [
    { href: '/settings', label: 'Organization settings', group: 'Settings' },
    ...SETTINGS_CATALOGUE.map((e) => ({ href: e.href, label: e.label, group: groupOf(e), keywords: e.keywords, searchOnly: true })),
  ];
  const find = (q: string) => filterCommands(commands, q).map((c) => c.href);

  it('"gst" finds the GST identity form', () => assert.ok(find('gst').includes('/settings/finance#gst-identity')));
  it('"reminder" finds the invoice reminders and the meeting reminder does not shadow them', () => assert.ok(find('reminder').includes('/settings/finance#past-due-reminders')));
  it('"window" finds the sending window and the template window', () => {
    const hits = find('window');
    assert.ok(hits.includes('/settings/communication#outreach-window'));
    assert.ok(hits.includes('/settings/communication#whatsapp-templates'));
  });
  it('"github" finds the GitHub token slot', () => assert.ok(find('github').includes('/security/keys#GITHUB_TOKEN')));
  it('"whatsapp" finds the number, the test recipient and the three WhatsApp secrets', () => {
    const hits = find('whatsapp');
    for (const h of ['/settings/communication#whatsapp', '/settings/communication#whatsapp-test-recipient', '/security/keys#WHATSAPP_ACCESS_TOKEN', '/security/keys#WHATSAPP_APP_SECRET', '/security/keys#WHATSAPP_VERIFY_TOKEN']) {
      assert.ok(hits.includes(h), h);
    }
  });
  it('an empty palette lists pages only — the catalogue appears once something is typed', () => {
    assert.deepEqual(find(''), ['/settings']);
    assert.deepEqual(find('   '), ['/settings']);
  });
  it('gibberish finds nothing', () => assert.deepEqual(find('zzqx'), []));
});

describe('the palette offers only what the role can open', () => {
  it('an owner is offered every entry', () => {
    assert.equal(catalogueFor('owner').length, SETTINGS_CATALOGUE.length);
    assert.equal(catalogueFor({ role: 'member', roles: ['member', 'owner'] }).length, SETTINGS_CATALOGUE.length, 'a granted role counts (the union)');
  });

  it('an ops admin (who lacks organization.settings, as in the nav), a delivery lead, a member, a contractor, a finance user and a client are offered none', () => {
    for (const role of ['ops_admin', 'delivery_lead', 'member', 'contractor', 'finance', 'client_admin', 'client_member'] as const) {
      assert.deepEqual(catalogueFor(role), [], role);
    }
    assert.deepEqual(catalogueFor(undefined), []);
  });

  it('the layout builds the palette from the catalogue filtered by the role, not from the raw list', () => {
    const layout = read('app/(internal)/layout.tsx');
    assert.match(layout, /catalogueFor\(context\)/);
    assert.doesNotMatch(layout, /SETTINGS_CATALOGUE/);
  });
});
