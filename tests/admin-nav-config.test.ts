import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CAPABILITIES } from '../src/lib/authz/permissions.ts';
import { currentItem, NAV_MODULES, trailFor, visibleModulesFor } from '../app/(internal)/nav-config.ts';

/**
 * The rail is the screen architecture's §2 list, in its order, and nothing
 * in it points at a page that does not exist or a capability that does not.
 */
describe('the admin navigation is the screen architecture, sectioned', () => {
  const LOCKED_ORDER = [
    'command-center',
    'sales',
    'clients',
    'projects',
    'requirements',
    'design',
    'development',
    'qa',
    'finance',
    'communication',
    'ai',
    'operations',
    'governance',
    'integrations',
    'settings',
  ];

  it('has the fifteen modules the PDF locks, in that order', () => {
    assert.deepEqual(
      NAV_MODULES.map((m) => m.key),
      LOCKED_ORDER,
    );
  });

  it('every item points at a route that exists under app/(internal)', () => {
    const root = join(process.cwd(), 'app', '(internal)');
    for (const m of NAV_MODULES) {
      for (const item of m.items) {
        const dir = join(root, ...item.href.split('/').filter(Boolean));
        assert.ok(existsSync(join(dir, 'page.tsx')), `${item.href} has no page.tsx`);
      }
    }
  });

  it('every capability an item names is a real capability', () => {
    for (const m of NAV_MODULES) {
      for (const item of m.items) {
        if (item.capability) assert.ok((CAPABILITIES as readonly string[]).includes(item.capability), item.href);
      }
    }
  });

  it('no href appears twice — one destination, one place in the building', () => {
    const hrefs = NAV_MODULES.flatMap((m) => m.items.map((i) => i.href));
    assert.equal(new Set(hrefs).size, hrefs.length);
  });

  it('every top-level page under app/(internal) is reachable from the rail or is a record/sub page', () => {
    // A page not in the rail must be a nested page of one that is — so
    // nothing an admin can open is unreachable except by typing the URL.
    const root = join(process.cwd(), 'app', '(internal)');
    const hrefs = new Set(NAV_MODULES.flatMap((m) => m.items.map((i) => i.href)));
    const topLevel = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('['))
      .map((d) => `/${d.name}`)
      .filter((href) => existsSync(join(root, href.slice(1), 'page.tsx')));
    // SCR-002: the global-search results page is reached from the ⌘K
    // palette's "see all results" row on every screen, not from the rail —
    // a rail entry for a page that needs a query typed first would be a
    // dead click. It is the one page reachable that way.
    const reachedFromPalette = new Set(['/search']);
    const unreachable = topLevel.filter(
      (href) => !reachedFromPalette.has(href) && ![...hrefs].some((h) => h === href || h.startsWith(href + '/')),
    );
    assert.deepEqual(unreachable, [], `not in the rail: ${unreachable.join(', ')}`);
  });
});

describe('what a role sees', () => {
  it('the owner sees every module', () => {
    assert.equal(visibleModulesFor('owner').length, NAV_MODULES.length);
  });

  it('finance sees only money, plus the always-shown approvals and personal queues', () => {
    const modules = visibleModulesFor('finance');
    const hrefs = modules.flatMap((m) => m.items.map((i) => i.href));
    assert.ok(hrefs.includes('/invoices'));
    assert.ok(hrefs.includes('/approvals'));
    assert.ok(!hrefs.includes('/leads'));
    assert.ok(!hrefs.includes('/settings'));
    assert.ok(!hrefs.includes('/invoices/verify'), 'finance holds invoice.read, not invoice.issue');
  });

  it('a contractor cannot see a single configuration or governance page', () => {
    const hrefs = visibleModulesFor('contractor').flatMap((m) => m.items.map((i) => i.href));
    for (const forbidden of ['/settings', '/security', '/audit', '/agents', '/integrations', '/leads', '/finance']) {
      assert.ok(!hrefs.includes(forbidden), forbidden);
    }
  });

  it('an unknown role sees only the always-shown items', () => {
    const hrefs = visibleModulesFor(undefined).flatMap((m) => m.items.map((i) => i.href));
    assert.deepEqual(hrefs.sort(), ['/approvals', '/my-tasks', '/notifications']);
  });
});

describe('which entry is lit', () => {
  const modules = visibleModulesFor('owner');

  it('an exact match wins', () => {
    assert.equal(currentItem('/finance', modules)?.item.href, '/finance');
  });

  it('a nested page lights its section, not its section\'s parent', () => {
    assert.equal(currentItem('/finance/payments', modules)?.item.href, '/finance/payments');
    assert.equal(currentItem('/finance/payments/abc', modules)?.item.href, '/finance/payments');
    assert.equal(currentItem('/invoices/verify', modules)?.item.href, '/invoices/verify');
    assert.equal(currentItem('/invoices/1234', modules)?.item.href, '/invoices');
  });

  it('matches at a segment boundary only', () => {
    assert.equal(currentItem('/importers', modules), null);
    assert.equal(currentItem('/projects/escalations', modules)?.item.href, '/projects/escalations');
    assert.equal(currentItem('/projects/1234/board', modules)?.item.href, '/projects');
  });

  it('the trail is module › page, and a deeper path is flagged by the caller', () => {
    assert.deepEqual(
      trailFor('/finance/payments', modules).map((c) => c.label),
      ['Finance', 'Payments'],
    );
    assert.deepEqual(
      trailFor('/dashboard', modules).map((c) => c.label),
      ['Command Center'],
    );
    assert.deepEqual(trailFor('/nowhere', modules), []);
  });
});
