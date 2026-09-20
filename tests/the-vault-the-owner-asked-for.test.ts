import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * The vault the owner asked for — ADM-84 §9 overturned 2026-09-20.
 *
 * `src/lib/ai/vault.ts` encrypts a provider key in application code before it
 * ever reaches Postgres. This proves the round trip against real Node crypto
 * (not a regex on the source), that a tampered row fails closed rather than
 * throwing, and that no encryption key means no database round trip at all.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

const envState: { VAULT_ENCRYPTION_KEY: string | undefined } = { VAULT_ENCRYPTION_KEY: 'test-vault-encryption-key-32-bytes-minimum' };
let adminClientCalls = 0;
let storedRow: { ciphertext: string; iv: string; auth_tag: string } | null = null;

const { mock: nodeMock } = await import('node:test');

nodeMock.module('@/lib/env', {
  exports: {
    serverEnv: () => envState,
  },
});

nodeMock.module('@/lib/db/admin', {
  exports: {
    createAdminClient: () => {
      adminClientCalls += 1;
      return {
        schema: () => ({
          from: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: storedRow, error: null }),
              }),
            }),
          }),
        }),
      };
    },
  },
});

const { setProviderCredential, getProviderCredential, providerCredentialStatus, VAULT_PROVIDERS } = await import('../src/lib/ai/vault.ts');

function fakeWriteClient(onUpsert: (row: Record<string, unknown>) => void) {
  return {
    schema: () => ({
      from: () => ({
        upsert: async (row: Record<string, unknown>) => {
          onUpsert(row);
          return { error: null };
        },
      }),
      rpc: async () => ({
        data: [
          { provider: 'anthropic', configured: true, updated_at: '2026-09-20T00:00:00Z' },
          { provider: 'openai', configured: false, updated_at: null },
        ],
        error: null,
      }),
    }),
  } as unknown as Parameters<typeof setProviderCredential>[0];
}

describe('A. a key round-trips through the vault, and nothing but ciphertext is stored', () => {
  test('what setProviderCredential writes is not the plaintext', async () => {
    let written: Record<string, unknown> | null = null;
    const client = fakeWriteClient((row) => { written = row; });
    const result = await setProviderCredential(client, 'openrouter', 'sk-or-real-secret-value', 'user-1');
    assert.equal(result.ok, true);
    assert.ok(written);
    const row = written as unknown as { ciphertext: string; iv: string; auth_tag: string; provider: string; updated_by: string };
    assert.equal(row.provider, 'openrouter');
    assert.equal(row.updated_by, 'user-1');
    assert.doesNotMatch(row.ciphertext, /sk-or-real-secret-value/);
    assert.ok(row.ciphertext.length > 0);
    assert.ok(row.iv.length > 0);
    assert.ok(row.auth_tag.length > 0);
  });

  test('and getProviderCredential recovers exactly the key that went in', async () => {
    let written: { ciphertext: string; iv: string; auth_tag: string } | null = null;
    const client = fakeWriteClient((row) => {
      written = { ciphertext: row.ciphertext as string, iv: row.iv as string, auth_tag: row.auth_tag as string };
    });
    await setProviderCredential(client, 'openai', 'sk-a-second-real-secret', 'user-1');
    storedRow = written;

    const before = adminClientCalls;
    const recovered = await getProviderCredential('openai');
    assert.equal(recovered, 'sk-a-second-real-secret');
    assert.equal(adminClientCalls, before + 1, 'the admin client is used, never the per-request one');
  });

  test('two writes of the same key produce different ciphertext (a fresh IV every time)', async () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const client = fakeWriteClient((row) => seen.push(row.ciphertext as string));
      await setProviderCredential(client, 'gemini', 'the-same-key', 'user-1');
    }
    assert.notEqual(seen[0], seen[1]);
  });
});

describe('B. a row that will not decrypt fails closed, not open', () => {
  test('a tampered auth tag is reported as unset, not thrown', async () => {
    storedRow = { ciphertext: Buffer.from('not really ciphertext').toString('base64'), iv: Buffer.alloc(12).toString('base64'), auth_tag: Buffer.alloc(16).toString('base64') };
    const recovered = await getProviderCredential('xai');
    assert.equal(recovered, null);
  });

  test('no row at all is also reported as unset', async () => {
    storedRow = null;
    const recovered = await getProviderCredential('xai');
    assert.equal(recovered, null);
  });
});

describe('C. no encryption key, no database round trip', () => {
  test('getProviderCredential short-circuits before ever building the admin client', async () => {
    envState.VAULT_ENCRYPTION_KEY = undefined;
    const before = adminClientCalls;
    const recovered = await getProviderCredential('anthropic');
    assert.equal(recovered, null);
    assert.equal(adminClientCalls, before, 'no admin client call — the vault cannot decrypt without the key, so it never asks');
    envState.VAULT_ENCRYPTION_KEY = 'test-vault-encryption-key-32-bytes-minimum';
  });
});

describe('D. setProviderCredential refuses what it should', () => {
  test('a blank key is refused', async () => {
    const client = fakeWriteClient(() => { throw new Error('should not write'); });
    const result = await setProviderCredential(client, 'openai', '   ', 'user-1');
    assert.equal(result.ok, false);
  });

  test('every vault provider id is one of the five ADM-85 named', () => {
    assert.deepEqual([...VAULT_PROVIDERS], ['anthropic', 'openai', 'gemini', 'xai', 'openrouter']);
  });
});

describe('E. status reports presence and moment, never the key', () => {
  test('providerCredentialStatus maps the RPC row shape without inventing fields', async () => {
    const client = fakeWriteClient(() => {});
    const result = await providerCredentialStatus(client);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, [
      { provider: 'anthropic', configured: true, updatedAt: '2026-09-20T00:00:00Z' },
      { provider: 'openai', configured: false, updatedAt: null },
    ]);
  });
});
