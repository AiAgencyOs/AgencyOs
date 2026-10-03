import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const DISPATCH = readFileSync(fileURLToPath(new URL('../src/lib/events/dispatch.ts', import.meta.url)), 'utf8');
const RUNNER = readFileSync(fileURLToPath(new URL('../app/api/jobs/run/agent-run.ts', import.meta.url)), 'utf8');

// Found by the router audit (2026-10-03): dispatch wrote `correlation_id: null`
// on every job, so event → job → agent run were three unrelated records.
describe('one event, one chain id', () => {
  test('jobs carry the event\'s chain id, never a hard-coded null', () => {
    assert.ok(!/correlation_id:\s*null/.test(DISPATCH));
    assert.match(DISPATCH, /correlation_id: correlationId,/);
  });

  test('the id is read from the event, kept when upstream set one, and stored when minted here', () => {
    assert.match(DISPATCH, /\.select\('id, organization_id, type, subject_type, subject_id, payload, attempts, correlation_id'\)/);
    assert.match(DISPATCH, /event\.correlation_id \?\? null/);
    assert.match(DISPATCH, /\.update\(\{ correlation_id: minted \}\)[\s\S]{0,80}\.is\('correlation_id', null\)/);
  });

  test('and the agent run inherits its job\'s id', () => {
    assert.match(RUNNER, /correlation_id: ctx\.job\.correlation_id \?\? ctx\.correlationId/);
  });
});
