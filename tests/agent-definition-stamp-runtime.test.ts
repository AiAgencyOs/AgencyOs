import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  AGENT_DEFINITIONS,
  registryRevision,
  revisionOf,
  type AgentDefinition,
} from '../src/modules/agents/registry.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

/**
 * The columns ADM-83 added to make drift visible had no producer where drift
 * happens.
 *
 * `definition_version` and `last_validated_at` were written only by
 * `scripts/verify-agent-definitions.mjs`, and that script resolves its target
 * through `.env.verify.local` **by design**, so a verification run can never
 * compete with the production queue. Correct — and it means production was
 * never stamped. Read on 2026-08-21: NULL on all six rows, and `/agents`
 * rendered every agent as `never` validated.
 *
 * A field that is always empty teaches a reader to stop looking at it.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const stampSource = read('../src/modules/agents/stamp.ts');
const routeSource = RUNNER_SOURCE;
const scriptSource = read('../scripts/verify-agent-definitions.mjs');

describe('A. the revision is over the definitions, not the file', () => {
  test('it is stable across calls', () => {
    assert.equal(registryRevision(), registryRevision());
  });

  test('it is a short hex fingerprint', () => {
    assert.match(registryRevision(), /^[0-9a-f]{12}$/);
  });

  test('registryRevision is revisionOf over the real roster, and nothing else', () => {
    assert.equal(registryRevision(), revisionOf(AGENT_DEFINITIONS));
  });

  test('changing any field changes the revision', () => {
    const before = registryRevision();
    const first = AGENT_DEFINITIONS[0];
    assert.ok(first, 'the roster is empty');
    const rest = AGENT_DEFINITIONS.slice(1);

    const changed: AgentDefinition[] = [
      { ...first, retry: { ...first.retry, maxAttempts: first.retry.maxAttempts + 1 } },
      ...rest,
    ];
    assert.notEqual(revisionOf(changed), before, 'a changed ceiling left the revision alone');

    const reAuthorised: AgentDefinition[] = [{ ...first, mayVerify: !first.mayVerify }, ...rest];
    assert.notEqual(revisionOf(reAuthorised), before, 'a changed verification authority was invisible');
  });

  test('adding an agent changes it', () => {
    const first = AGENT_DEFINITIONS[0];
    assert.ok(first, 'the roster is empty');
    const more = [...AGENT_DEFINITIONS, { ...first, key: 'zz_new_agent' }];
    assert.notEqual(revisionOf(more), registryRevision());
  });

  test('but reordering does not — the hash is over content, not layout', () => {
    // A refactor that moves a literal, or lists capabilities in another order,
    // must not look like a definition change. Otherwise the field cries wolf
    // and a reader learns to ignore it.
    assert.equal(revisionOf([...AGENT_DEFINITIONS].reverse()), registryRevision());

    const first = AGENT_DEFINITIONS[0];
    assert.ok(first, 'the roster is empty');
    const shuffled: AgentDefinition[] = [
      { ...first, capabilities: [...first.capabilities].reverse() },
      ...AGENT_DEFINITIONS.slice(1),
    ];
    assert.equal(revisionOf(shuffled), registryRevision());
  });

  test('a runtime cannot read its own source, which is why it is not a file hash', () => {
    const registry = read('../src/modules/agents/registry.ts');
    assert.ok(!/readFileSync/.test(registry.slice(registry.indexOf('export function registryRevision'))),
      'registryRevision reads a file — bundled runtimes cannot');
  });
});

describe('B. production has a producer now', () => {
  test('the sweep lives in the module that owns the registry', () => {
    // ARCHITECTURE.md §3.2: lib/ must not depend on modules/. The first
    // version of this file sat in src/lib/ai/ and the boundary refused it,
    // correctly — the registry is a module concern.
    assert.match(stampSource, /from '\.\/registry'/);
    assert.ok(!/@\/modules\//.test(stampSource), 'the module imports itself through the alias');
  });

  test('the tick calls it', () => {
    assert.match(routeSource, /import \{ stampAgentDefinitions \} from '@\/modules\/agents\/stamp'/);
    assert.match(routeSource, /const stamps = await stampAgentDefinitions\(admin\)/);
  });

  test('and reports it, so a tick that stamped nothing is visible', () => {
    assert.match(routeSource, /\n\s+stamps,\n/);
  });

  test('it writes only stale rows, so the steady state costs no write', () => {
    assert.match(stampSource, /r\.definition_version !== revision/);
    assert.match(stampSource, /if \(stale\.length === 0\)/);
    assert.match(stampSource, /stale\.map\(\(r\) => r\.key\)/);
  });

  test('it stamps only agents the registry describes', () => {
    // lead_qualifier and proposal_drafter are rows ADM-82 folded into the
    // sales agent and preserved. There is no revision to validate them
    // against, and inventing one would be the misinformation the column
    // exists to prevent.
    assert.match(stampSource, /AGENT_DEFINITIONS\.map\(\(a\) => a\.key\)/);
    assert.match(stampSource, /\.in\('key', defined\)/);
  });

  test('a failure to stamp never stops the tick', () => {
    // Beside the heartbeat and the alerts: this is bookkeeping, and
    // bookkeeping that fails must not stop the work.
    assert.match(stampSource, /failures: \[error\.message\]/);
    assert.ok(!/throw /.test(stampSource), 'the sweep throws');
  });
});

describe('C. one revision, two producers', () => {
  test('the script imports it rather than recomputing it', () => {
    // Two producers deriving a revision two different ways is drift between
    // the things that exist to detect drift.
    assert.match(scriptSource, /import \{ registryRevision \}/);
    assert.match(scriptSource, /const VERSION = registryRevision\(\)/);
  });

  test('and no longer hashes the file behind its own back', () => {
    assert.ok(
      !/createHash\('sha256'\)\.update\(registrySource\)/.test(scriptSource),
      'the script still computes its own revision',
    );
  });
});
