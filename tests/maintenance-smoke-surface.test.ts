import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, 'utf8');
const queries = read('src/modules/projects/maintenance-smoke-queries.ts');
const actions = read('src/modules/projects/maintenance-smoke-actions.ts');
const panel = read('app/(internal)/projects/[projectId]/maintenance-smoke-panel.tsx');

describe('smoke failure surface', () => {
  test('every query read guards its error with unreadable', () => {
    const guards = queries.match(/if \(\w+\.error\)/g)?.length ?? 0;
    const refusals = queries.match(/unreadable\(/g)?.length ?? 0;
    assert.ok(guards >= 2);
    assert.equal(guards, refusals);
  });
  test('the actions file is use-server and exports only async functions', () => {
    assert.match(actions, /^'use server';/);
    const exports = actions.match(/^export .*/gm) ?? [];
    assert.equal(exports.length, 2);
    for (const e of exports) assert.match(e, /^export async function \w+Action\(/);
  });
  test('the actions call the doors and the person is the actor (no admin client)', () => {
    assert.match(actions, /report_maintenance_smoke_failure/);
    assert.match(actions, /decide_maintenance_smoke_failure/);
    assert.doesNotMatch(actions, /createAdminClient/);
    assert.match(actions, /can\(context, 'project\.write'\)/);
  });
  test('the panel offers the decision only to someone who did not report the failure, and says nothing is rolled back', () => {
    assert.match(panel, /f\.reportedBy !== view\.viewerId/);
    assert.match(panel, /rolls nothing back/);
  });
});
