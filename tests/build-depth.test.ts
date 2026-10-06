import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  BUILD_CONFIG_KEYS,
  buildConfigPayload,
  cancelOutcomeMessage,
  configOutcomeMessage,
  packageOutcomeMessage,
  readReproducibility,
  REPRODUCIBILITY_LABEL,
  toClientBuildPackage,
} from '../src/modules/projects/build-depth-schema.ts';
import { maskSecrets } from '../src/modules/projects/build-runner.ts';

// Fake secret-looking fixtures are assembled here, never written whole (scan:secrets).
const fixtures: Record<string, string> = {
  sk: ['sk', '-', 'a'.repeat(24)].join(''),
  ghp: ['gh', 'p_', 'b'.repeat(30)].join(''),
  gho: ['gh', 'o_', 'c'.repeat(30)].join(''),
  xox: ['xo', 'xb-', '1'.repeat(14)].join(''),
  aws: ['AK', 'IA', 'Q'.repeat(16)].join(''),
  jwt: ['ey', 'J', 'h'.repeat(14), '.', 'p'.repeat(14), '.', 's'.repeat(10)].join(''),
  url: ['postgres://user:', 'hunter', '22@db.example.test/app'].join(''),
  pair: ['pass', 'word=', 'swordfish1'].join(''),
  tokenPair: ['tok', 'en: ', 'abcdef123456'].join(''),
  bearer: ['Bearer', ' ', 'z'.repeat(20)].join(''),
  pem: ['-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEvQIBADANBgkq\nabcdef\n', '-----END ', 'RSA PRIVATE KEY-----'].join(''),
  pemCut: ['-----BEGIN ', 'PRIVATE KEY-----\nTRUNCATEDBODYLINE'].join(''),
};
// the secret part of each fixture, which must not survive masking
const needle: Record<string, string> = {
  sk: 'a'.repeat(24), ghp: 'b'.repeat(30), gho: 'c'.repeat(30), xox: '1'.repeat(14), aws: 'Q'.repeat(16), jwt: 'h'.repeat(14), url: 'hunter',
  pair: 'swordfish1', tokenPair: 'abcdef123456', bearer: 'z'.repeat(20), pem: 'MIIEvQIBADANBgkq', pemCut: 'TRUNCATEDBODYLINE',
};

describe('maskSecrets: the same families the database re-masks', () => {
  for (const key of Object.keys(fixtures)) {
    test(`masks ${key}`, () => {
      const out = maskSecrets(`before\n${fixtures[key]}\nafter`);
      assert.ok(!out.includes(needle[key]!), key);
      // a key block that was cut off takes everything after its header with it; every other family leaves the lines around it
      assert.ok(out.includes('before') && out.includes('[masked]') && (key === 'pemCut' || out.includes('after')), key);
    });
  }
  test('leaves an ordinary log alone', () => {
    assert.equal(maskSecrets('npm ci ok\nbuilt 12 files in 3s'), 'npm ci ok\nbuilt 12 files in 3s');
  });
  test('is idempotent: masking twice is masking once (the database masks again)', () => {
    const once = maskSecrets(Object.values(fixtures).join('\n'));
    assert.equal(maskSecrets(once), once);
  });
});

describe('the SQL mask carries every family the TS mask does', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261102200000_build_logs_are_masked_in_the_database_too.sql', import.meta.url), 'utf8');
  const families = ['sk-', 'gh[pousr]_', 'xox[abprs]-', 'AKIA', 'eyJ', 'PRIVATE KEY', '://', 'Bearer', 'password|passwd'];
  for (const f of families) test(`mask_secrets handles ${f}`, () => assert.ok(sql.includes(f), f));
  test('the table masks on insert as well as the door (two layers)', () => {
    assert.match(sql, /new\.masked_text := projects\.mask_secrets\(new\.masked_text\)/);
    assert.match(sql, /v_text := left\(projects\.mask_secrets\(p_text\), 50000\)/);
  });
  test('the door is service-role only and there is no client path to logs', () => {
    assert.match(sql, /revoke all on function projects\.append_build_log\(uuid, text, text\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function projects\.append_build_log\(uuid, text, text\) to service_role;/);
    assert.match(sql, /build_logs_read on projects\.build_logs for select to authenticated\s+using \(organization_id = \(select core\.current_organization_id\(\)\) and \(select core\.is_internal\(\)\)\)/);
  });
});

describe('buildConfigPayload', () => {
  test('keeps filled settings, drops blanks, splits env names', () => {
    const r = buildConfigPayload({ node_version: ' 22 ', build_command: '', package_manager: 'npm' }, 'NEXT_PUBLIC_URL, SENTRY_DSN NEXT_PUBLIC_URL');
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.payload, { node_version: '22', package_manager: 'npm', env_names: ['NEXT_PUBLIC_URL', 'SENTRY_DSN'] });
  });
  test('an environment variable is a NAME: a value or a lower-case word is refused', () => {
    const r = buildConfigPayload({}, ['my', 'Key=v1'].join(''));
    assert.ok(!r.ok);
    assert.ok(!buildConfigPayload({ node_version: '22' }, 'lower_case').ok);
  });
  test('an empty form is refused', () => {
    assert.ok(!buildConfigPayload({}, '').ok);
  });
  test('only known keys are ever sent', () => {
    const r = buildConfigPayload({ node_version: '22', evil: 'x' }, '');
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(Object.keys(r.payload), ['node_version']);
    assert.equal(new Set(BUILD_CONFIG_KEYS).size, BUILD_CONFIG_KEYS.length);
  });
});

describe('outcome words read to a person', () => {
  test('every gate the database names has its own sentence', () => {
    for (const o of ['not_qa_passed', 'not_admin_approved', 'no_artifact', 'artifact_not_newest', 'no_smoke', 'stale_config']) {
      assert.notEqual(packageOutcomeMessage(o), packageOutcomeMessage('something_else'), o);
    }
    assert.match(configOutcomeMessage('secret_in_config'), /never its value/);
    assert.match(cancelOutcomeMessage('already_settled'), /already settled/);
  });
});

describe('reproducibility is never claimed from one run', () => {
  test('only the three database words are understood; anything else is unknown, not a claim', () => {
    assert.equal(readReproducibility('reproduced'), 'reproduced');
    assert.equal(readReproducibility('differs'), 'differs');
    assert.equal(readReproducibility('single_run'), 'single_run');
    assert.equal(readReproducibility('yes'), null);
    assert.equal(readReproducibility(null), null);
  });
  test('the single-run label says it proves nothing', () => {
    assert.match(REPRODUCIBILITY_LABEL.single_run, /proves nothing/);
  });
});

describe('the client package is a whitelist', () => {
  const row = {
    title: 'Build 3', version: 3, label: 'Development build, not production', platform: 'web', artifact_type: 'web_bundle', distributable: true, artifact_limitation: null,
    limitations: 'Web only', testing_instructions: 'Open the link', packaged_at: '2026-11-02T10:00:00Z',
    // what must never reach a client, even if a future version of the function returned it
    stages: [{ name: 'build' }], fingerprint: { node: '22' }, commit_ref: 'abc123', build_run_id: 'r', build_artifact_id: 'a', masked_text: 'log', storage_ref: 's3://x',
  };
  test('carries the label, limitations and testing instructions', () => {
    const p = toClientBuildPackage(row);
    assert.equal(p?.label, 'Development build, not production');
    assert.equal(p?.limitations, 'Web only');
    assert.equal(p?.testingInstructions, 'Open the link');
  });
  test('drops logs, stages, fingerprint, commit and internal ids', () => {
    const json = JSON.stringify(toClientBuildPackage(row));
    for (const leaked of ['stages', 'fingerprint', 'abc123', 'build_run_id', 'build_artifact_id', 'masked_text', 's3://x', '"log"']) assert.ok(!json.includes(leaked), leaked);
  });
  test('a missing label still reads as a development build, never as production', () => {
    assert.equal(toClientBuildPackage({ ...row, label: undefined })?.label, 'Development build, not production');
  });
  test('no row, no package', () => {
    assert.equal(toClientBuildPackage(undefined), null);
    assert.equal(toClientBuildPackage({ ...row, limitations: undefined }), null);
  });
});

describe('the pieces are reachable, not just built', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  test('the worker report stores its stage logs through the masked door', () => {
    const svc = read('src/modules/projects/build-report-service.ts');
    assert.match(svc, /import \{ appendBuildLog \} from '\.\/build-logs-service'/);
    assert.match(svc, /appendBuildLog\(admin, runId, s\.name, s\.log\)/);
  });
  test('the log service masks before it sends, and only through the service-role door', () => {
    const svc = read('src/modules/projects/build-logs-service.ts');
    assert.match(svc, /maskSecrets\(text\)/);
    assert.match(svc, /rpc\('append_build_log'/);
  });
  test('the panel reads the database answers for the client package and reproducibility', () => {
    const panel = read('app/(internal)/projects/[projectId]/build-depth-panel.tsx');
    assert.match(panel, /readClientBuildPackage\(b\.id\)/);
    assert.match(panel, /readBuildReproducibility\(b\.id, commit\)/);
  });
});
