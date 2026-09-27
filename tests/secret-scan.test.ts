import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scanPrototypeBuildForSecrets } from '../src/modules/qa/secret-scan.ts';
import { SECRET_PATTERNS } from '../src/lib/security/secret-patterns.ts';

/**
 * Prototype QA's PA4-T030: "Build contains provider/API secret → Security
 * FAIL." One case per shared pattern shape, plus the literal spec case.
 */

const CANARY: Record<string, string> = {
  'JSON Web Token': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.',
  'Supabase secret key': 'sb_secret_ABCDEFGHIJKLMNOPqrst',
  'Anthropic API key': 'sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX',
  'OpenAI API key': `sk-${'a'.repeat(48)}`,
  'AWS access key id': 'AKIAABCDEFGHIJKLMNOP',
  'GitHub token': `ghp_${'a'.repeat(36)}`,
  'Private key block': '-----BEGIN RSA PRIVATE KEY-----',
  'Slack token': 'xoxb-1234567890-abcdefghij',
};

describe('scanPrototypeBuildForSecrets — PA4-T030', () => {
  test('every shared pattern has a canary case here', () => {
    for (const { name } of SECRET_PATTERNS) {
      assert.ok(name in CANARY, `no canary sample for pattern "${name}" — add one`);
    }
  });

  test('a clean build produces no findings', () => {
    const findings = scanPrototypeBuildForSecrets([
      { screenKey: 'dashboard', elements: [{ label: 'Refresh data', navigatesTo: 'dashboard' }] },
    ]);
    assert.deepEqual(findings, []);
  });

  for (const [pattern, sample] of Object.entries(CANARY)) {
    test(`detects a "${pattern}"-shaped label`, () => {
      const findings = scanPrototypeBuildForSecrets([
        { screenKey: 'dashboard', elements: [{ label: `Token: ${sample}` }] },
      ]);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]!.pattern, pattern);
      assert.equal(findings[0]!.screenKey, 'dashboard');
      assert.equal(findings[0]!.elementIndex, 0);
    });
  }

  test('PA4-T030 literal case: a provider API key in an element label', () => {
    const findings = scanPrototypeBuildForSecrets([
      {
        screenKey: 'settings',
        elements: [
          { label: 'Save changes' },
          { label: `Anthropic key: ${CANARY['Anthropic API key']}` },
        ],
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.elementIndex, 1);
  });

  test('multiple screens and multiple findings are each reported', () => {
    const findings = scanPrototypeBuildForSecrets([
      { screenKey: 'a', elements: [{ label: CANARY['AWS access key id']! }] },
      { screenKey: 'b', elements: [{ label: 'fine' }, { label: CANARY['Slack token']! }] },
    ]);
    assert.equal(findings.length, 2);
    assert.deepEqual(
      findings.map((f) => f.screenKey),
      ['a', 'b'],
    );
  });
});
