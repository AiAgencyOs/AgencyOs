import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

/**
 * The Provider Manager's screens, held to the contract the rest of the system depends on. These are source-level on purpose: the
 * behaviour behind them is proved live by verify-ai-providers / verify-ai-routing; what this pins is where the screens are NOT
 * allowed to reach - the secrets, the database directly - and that the old duplicate key screens are gone rather than merely joined.
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const actions = strip(read('app/(internal)/agents/providers/actions.ts'));
const forms = strip(read('app/(internal)/agents/providers/forms.tsx'));
const queries = strip(read('src/lib/ai/manager-queries.ts'));
const keysPage = read('app/(internal)/security/keys/page.tsx');
const keyForms = read('app/(internal)/security/keys/key-forms.tsx');
const nav = read('app/(internal)/nav-config.ts');

describe('the Provider Manager screens', () => {
  test('actions go through the services; none touches the database itself', () => {
    assert.ok(/from '@\/lib\/ai\/provider-admin'/.test(actions) && /from '@\/lib\/ai\/routing-admin'/.test(actions), 'the services are what the actions call');
    assert.ok(!/\.rpc\(|\.from\(|createAdminClient/.test(actions), 'no raw database access in an action');
    assert.ok(!/\.rpc\(|\.from\(/.test(forms), 'no raw database access in a form');
  });

  test('a key is typed into a password field and never pre-filled or echoed back', () => {
    const secretInputs = forms.match(/<input[^>]*name="secret"[^>]*>/g) ?? [];
    assert.ok(secretInputs.length >= 2, 'add and rotate both take a secret');
    for (const tag of secretInputs) {
      assert.ok(/type="password"/.test(tag), `a secret field is a password field: ${tag.slice(0, 60)}`);
      assert.ok(!/defaultValue|value=/.test(tag), 'and is never given a value');
    }
    // The action's messages never interpolate the secret.
    assert.ok(!/\$\{[^}]*secret[^}]*\}/i.test(actions), 'no message interpolates the key');
  });

  test('what the screens read never includes a ciphertext', () => {
    assert.ok(!/ciphertext|auth_tag|\biv\b/.test(queries), 'the readers do not select ciphertext columns');
    assert.ok(/provider_key_status/.test(queries), 'and keys come through the status door');
  });

  test('every mutation is in the actions file, and each is reachable from a form', () => {
    const exported = [...actions.matchAll(/export async function (\w+Action)/g)].map((m) => m[1]);
    assert.ok(exported.length >= 14, `${exported.length} actions`);
    for (const name of exported) assert.ok(new RegExp(`\\b${name}\\b`).test(forms), `${name} is wired to a form (not built and unreachable)`);
  });

  test('the mode switch asks for a reason and the manual table is built from the registry, not a fixed list', () => {
    assert.ok(/name="reason"[^>]*required/.test(forms), 'a reason is required');
    assert.ok(!/PROVIDER_IDS|\['anthropic', 'openai'/.test(forms + strip(read('app/(internal)/agents/providers/page.tsx'))), 'no hard-coded provider list');
    assert.ok(/options\s*=\s*enabledModels/.test(read('app/(internal)/agents/providers/page.tsx')), 'assignable targets come from the enabled models of usable providers');
  });
});

describe('the old key screens are consolidated, not duplicated', () => {
  test('Security > Keys sends AI provider keys to the manager and no longer renders the legacy forms', () => {
    assert.ok(/Manage in AI providers/.test(keysPage), 'the pointer is there');
    assert.ok(!/providerVault=\{/.test(keysPage), 'the legacy provider-vault prop is no longer passed to the forms');
    assert.ok(!/setProviderCredentialAction|revokeProviderCredentialAction/.test(keyForms), 'the forms no longer post to the legacy actions');
  });

  test('the Agents and Model-routing pages no longer carry a second key form', () => {
    for (const p of ['app/(internal)/agents/page.tsx', 'app/(internal)/agents/routing/page.tsx']) {
      const src = read(p);
      assert.ok(!/SetProviderCredentialForm|RevokeProviderCredentialForm/.test(src), `${p} has no key form`);
      assert.ok(/\/agents\/providers/.test(src), `${p} points to the manager`);
    }
  });

  test('the manager is in the navigation', () => {
    assert.ok(/href: '\/agents\/providers'/.test(nav));
  });
});
