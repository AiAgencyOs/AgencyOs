import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './_code-only.ts';

/**
 * A secret is read through the resolver — the Keys & secrets screen's promise.
 *
 * A key an owner stores in the vault must take effect. That is true only if no
 * consumer reads the nine stored-key slots straight from the environment, so
 * this file pins both halves:
 *
 *   A. no file outside the env declaration, the secrets module and the
 *      env-only listing reads one of the nine slots through `serverEnv()`,
 *      `env.` or `process.env.`; and every consumer names `resolveSecret` or
 *      `secretConfigured`.
 *   B. `resolveSecret` itself: the environment wins, an unknown key is null,
 *      and with the vault unconfigured the answer is exactly the env value.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const SLOTS = [
  'GITHUB_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'RESEND_API_KEY',
  'SMTP_PASS',
  'ALERT_WEBHOOK_URL',
  'FIGMA_ACCESS_TOKEN',
  'GOOGLE_SERVICE_ACCOUNT_KEY',
] as const;

const EXEMPT = [
  'src/lib/env.ts',
  'src/lib/env-schema.ts',
  'src/lib/admin/config-status.ts', // its own env-only listing names the keys as data
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(relative('.', rel));
    }
  }
  return out;
}

const SOURCES = [...walk('src'), ...walk('app')].filter(
  (f) => !EXEMPT.includes(f) && !f.startsWith('src/lib/secrets/') && f !== 'src/lib/db/types.ts',
);

const names = SLOTS.join('|');
const PROPERTY = new RegExp(`\\b(?:serverEnv\\(\\)|env|process\\.env)\\s*\\??\\.\\s*(${names})\\b`);
const BRACKET = new RegExp(`\\b(?:serverEnv\\(\\)|env|process\\.env)\\s*\\[\\s*['"](${names})['"]\\s*\\]`);
const DESTRUCTURED = new RegExp(`\\{[^}]*\\b(${names})\\b[^}]*\\}\\s*=\\s*(?:serverEnv\\(\\)|env|process\\.env)\\b`);

describe('A. no consumer reads a stored-key slot from the environment directly', () => {
  test('the scan covers the source tree', () => {
    assert.ok(SOURCES.length > 300, `only ${SOURCES.length} files scanned`);
  });

  for (const shape of [
    ['property access (serverEnv().X, env.X, process.env.X)', PROPERTY],
    ['bracket access (env["X"])', BRACKET],
    ['destructuring ({ X } = serverEnv())', DESTRUCTURED],
  ] as const) {
    test(`none of the nine slots is read by ${shape[0]}`, () => {
      const offenders = SOURCES.filter((f) => shape[1].test(codeOnly(read(f))));
      assert.deepEqual(offenders, [], `read a secret straight from the environment; use resolveSecret(): ${offenders.join(', ')}`);
    });
  }
});

describe('A. every consumer goes through the resolver', () => {
  const CONSUMERS: [string, string][] = [
    ['src/lib/git/github.ts', 'GITHUB_TOKEN'],
    ['src/lib/whatsapp/send.ts', 'WHATSAPP_ACCESS_TOKEN'],
    ['src/lib/whatsapp/media.ts', 'WHATSAPP_ACCESS_TOKEN'],
    ['app/api/webhooks/whatsapp/route.ts', 'WHATSAPP_APP_SECRET'],
    ['app/api/webhooks/whatsapp/route.ts', 'WHATSAPP_VERIFY_TOKEN'],
    ['src/lib/admin/whatsapp-verify.ts', 'WHATSAPP_ACCESS_TOKEN'],
    ['src/lib/admin/whatsapp-readiness.ts', 'WHATSAPP_ACCESS_TOKEN'],
    ['src/lib/email/transport.ts', 'RESEND_API_KEY'],
    ['src/lib/email/transport.ts', 'SMTP_PASS'],
    ['src/lib/observability/alert.ts', 'ALERT_WEBHOOK_URL'],
    ['src/lib/figma/client.ts', 'FIGMA_ACCESS_TOKEN'],
    ['src/lib/scheduling/google.ts', 'GOOGLE_SERVICE_ACCOUNT_KEY'],
  ];

  for (const [file, slot] of CONSUMERS) {
    test(`${file} resolves ${slot}`, () => {
      const code = codeOnly(read(file));
      assert.match(code, /from '@\/lib\/secrets\/resolve'/, 'imports the resolver');
      assert.match(code, new RegExp(`(?:resolveSecret|secretConfigured)\\(\\s*'${slot}'\\s*\\)`), `asks the resolver for ${slot}`);
    });
  }

  test('the readiness readers go through the resolved config status', () => {
    for (const file of ['src/lib/admin/integrations.ts', 'src/lib/admin/production-readiness.ts', 'src/lib/admin/overview.ts']) {
      const code = codeOnly(read(file));
      assert.match(code, /configStatusResolved\(\)/, file);
      assert.doesNotMatch(code, /[^\w]configStatus\(\)/, `${file} must not read the env-only listing`);
    }
    const config = codeOnly(read('src/lib/admin/config-status-resolved.ts'));
    assert.match(config, /export async function configStatusResolved/);
    assert.match(config, /secretSource\(item\.key\)/);
  });

  test('a sync read is not left behind: the async readers are awaited', () => {
    assert.match(codeOnly(read('app/(internal)/projects/[projectId]/repository/github-panel.tsx')), /await githubConfigured\(\)/);
    assert.match(codeOnly(read('app/(internal)/projects/[projectId]/design/themes/page.tsx')), /await figmaConfigured\(\)/);
    assert.match(codeOnly(read('app/(internal)/invoices/[invoiceId]/page.tsx')), /await emailTransportState\(\)/);
    assert.match(codeOnly(read('src/modules/finance/email-send-service.ts')), /await emailTransportState\(\)/);
    assert.match(codeOnly(read('app/(internal)/meetings/page.tsx')), /await googleCalendarConfig\(\)/);
    assert.match(codeOnly(read('app/(internal)/meetings/[meetingId]/page.tsx')), /await googleCalendarConfig\(\)/);
  });
});

// ── B. the resolver's precedence ─────────────────────────────────────────────

const env: Record<string, unknown> = {};
let vaultValue: string | null = null;
let providerValue: string | null = null;
let vaultCalls = 0;

mock.module('@/lib/env', { exports: { serverEnv: () => env } });
mock.module('@/lib/secrets/vault', {
  exports: {
    readVaultSecret: async () => {
      vaultCalls += 1;
      return vaultValue;
    },
    vaultHas: async () => vaultValue !== null,
  },
});
mock.module('@/lib/ai/vault', { exports: { getProviderCredential: async () => providerValue } });

const { resolveSecret, secretConfigured, secretSource } = await import('../src/lib/secrets/resolve.ts');

function reset() {
  for (const k of Object.keys(env)) delete env[k];
  vaultValue = null;
  providerValue = null;
  vaultCalls = 0;
}

describe('B. resolveSecret precedence', () => {
  test('the environment wins over the vault', async () => {
    reset();
    env.GITHUB_TOKEN = '  ghp_from_environment  ';
    vaultValue = 'ghp_from_vault';
    assert.equal(await resolveSecret('GITHUB_TOKEN'), 'ghp_from_environment');
    assert.equal(vaultCalls, 0, 'the vault is not asked when the environment answers');
    assert.deepEqual(await secretSource('GITHUB_TOKEN'), { source: 'env', vaultShadowed: true });
  });

  test('the vault answers when the environment has nothing (or only blanks)', async () => {
    reset();
    env.GITHUB_TOKEN = '   ';
    vaultValue = 'ghp_from_vault';
    assert.equal(await resolveSecret('GITHUB_TOKEN'), 'ghp_from_vault');
    assert.equal(await secretConfigured('GITHUB_TOKEN'), true);
    assert.deepEqual(await secretSource('GITHUB_TOKEN'), { source: 'vault', vaultShadowed: false });
  });

  test('vault unconfigured: the answer is exactly the environment value, or null', async () => {
    reset();
    env.RESEND_API_KEY = 're_abcdefghijkl';
    assert.equal(await resolveSecret('RESEND_API_KEY'), 're_abcdefghijkl');
    assert.equal(await resolveSecret('SMTP_PASS'), null);
    assert.equal(await secretConfigured('SMTP_PASS'), false);
    assert.deepEqual(await secretSource('SMTP_PASS'), { source: 'none', vaultShadowed: false });
  });

  test('an unknown key is null, even when the environment has it', async () => {
    reset();
    vaultValue = 'should-not-be-read';
    assert.equal(await resolveSecret('NOT_A_SLOT'), null);
    assert.equal(vaultCalls, 0);
  });

  test('an environment-only slot never consults the vault', async () => {
    reset();
    vaultValue = 'should-not-be-read';
    assert.equal(await resolveSecret('CRON_SECRET'), null);
    assert.equal(vaultCalls, 0);
    env.CRON_SECRET = 'cron-secret-value';
    assert.equal(await resolveSecret('CRON_SECRET'), 'cron-secret-value');
  });

  test('an AI provider slot falls back to the provider vault', async () => {
    reset();
    providerValue = 'sk-from-provider-vault';
    assert.equal(await resolveSecret('ANTHROPIC_API_KEY'), 'sk-from-provider-vault');
    env.ANTHROPIC_API_KEY = 'sk-from-env';
    assert.equal(await resolveSecret('ANTHROPIC_API_KEY'), 'sk-from-env');
  });
});
