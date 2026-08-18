import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { filterCommands, type Command } from '../src/lib/admin/command-palette-eval.ts';

const commands: Command[] = [
  { href: '/dashboard', label: 'Overview', group: 'Overview' },
  { href: '/production-readiness', label: 'Production readiness', group: 'Operations' },
  { href: '/security', label: 'Security', group: 'Operations' },
  { href: '/usage', label: 'Usage & costs', group: 'Operations' },
  { href: '/settings', label: 'Settings', group: 'Configuration' },
];

describe('filterCommands', () => {
  test('an empty query returns everything, in order', () => {
    assert.deepEqual(filterCommands(commands, ''), commands);
    assert.deepEqual(filterCommands(commands, '   '), commands);
  });

  test('matches on label, case-insensitively', () => {
    const r = filterCommands(commands, 'secur');
    assert.equal(r.length, 1);
    assert.equal(r[0]!.href, '/security');
  });

  test('every term must appear (AND, not OR) — "production read" finds only Production readiness', () => {
    const r = filterCommands(commands, 'production read');
    assert.equal(r.length, 1);
    assert.equal(r[0]!.href, '/production-readiness');
    // "usage production" matches neither in full, so it returns nothing (AND semantics).
    assert.deepEqual(filterCommands(commands, 'usage production'), []);
  });

  test('matches on the section too', () => {
    const ops = filterCommands(commands, 'operations');
    assert.deepEqual(ops.map((c) => c.href).sort(), ['/production-readiness', '/security', '/usage']);
  });

  test('a non-match returns nothing (never a false hit)', () => {
    assert.deepEqual(filterCommands(commands, 'zzz nothing'), []);
  });

  test('the palette only ever searches what it was given (capability-filtered upstream)', () => {
    // If Settings was withheld server-side, it simply is not in the list to find.
    const withoutSettings = commands.filter((c) => c.href !== '/settings');
    assert.equal(filterCommands(withoutSettings, 'settings').length, 0);
  });
});
