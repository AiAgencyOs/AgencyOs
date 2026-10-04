import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { ADAPTERS } from '../src/modules/acquisition/adapters.ts';
import { canonicalJson, contentHash } from '../src/modules/acquisition/content-hash.ts';
import {
  beginExecution,
  decideAction,
  NEVER_AUTO,
} from '../src/modules/acquisition/governance.ts';
import { ACTION_TYPES } from '../src/modules/acquisition/policy-vocabulary.ts';
import {
  backoffSeconds,
  CAPABILITIES,
  CAPABILITY_MODES,
  classifyProviderError,
  isRetryable,
  PROVIDER_CATALOG,
  PROVIDERS,
  VERIFICATION_STATES,
  VERIFICATION_WORDS,
} from '../src/modules/acquisition/providers.ts';
import { APPROVAL_SUBJECT_TYPES } from '../src/modules/approvals/schema.ts';
import { hintOfSecret, openForTenant, sealForTenant } from '../src/lib/secrets/tenant-vault.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261016100000_connectors_policy_and_exact_version_approval.sql');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};
const listIn = (text: string) => [...text.matchAll(/'([A-Za-z_0-9]+)'/g)].map((m) => m[1]);

const CTX = { organizationId: '00000000-0000-4000-8000-000000000001', integrationId: '00000000-0000-4000-8000-0000000000aa', name: 'access_token' };
const KEY = 'a-vault-key-for-the-test';

describe('lead generation, slice 4 - connectors, one policy question, exact-version approvals', () => {
  describe('tenant-bound encryption', () => {
    test('round-trips, and a new IV makes every ciphertext different', () => {
      const a = sealForTenant('super-secret-token-123', CTX, KEY);
      const b = sealForTenant('super-secret-token-123', CTX, KEY);
      assert.equal(openForTenant(a, CTX, KEY), 'super-secret-token-123');
      assert.notEqual(a.ciphertext, b.ciphertext);
      assert.notEqual(a.iv, b.iv);
      assert.ok(!a.ciphertext.includes('super-secret'));
    });

    test('a ciphertext moved to another organisation, integration or credential name does NOT decrypt', () => {
      const sealed = sealForTenant('tenant-a-token-value', CTX, KEY);
      assert.throws(() => openForTenant(sealed, { ...CTX, organizationId: '00000000-0000-4000-8000-0000000000b2' }, KEY), 'another tenant');
      assert.throws(() => openForTenant(sealed, { ...CTX, integrationId: '00000000-0000-4000-8000-0000000000ab' }, KEY), 'another integration');
      assert.throws(() => openForTenant(sealed, { ...CTX, name: 'refresh_token' }, KEY), 'another slot');
    });

    test('a wrong key, a tampered tag or tampered ciphertext fails; an empty key is refused outright', () => {
      const sealed = sealForTenant('another-secret-value-1', CTX, KEY);
      assert.throws(() => openForTenant(sealed, CTX, `${KEY}x`));
      assert.throws(() => openForTenant({ ...sealed, authTag: sealForTenant('x'.repeat(8), CTX, KEY).authTag }, CTX, KEY));
      const bytes = Buffer.from(sealed.ciphertext, 'base64');
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      assert.throws(() => openForTenant({ ...sealed, ciphertext: bytes.toString('base64') }, CTX, KEY));
      assert.throws(() => sealForTenant('value-value-1', CTX, ''));
    });

    test('the hint is the last four characters of a long value and nothing of a short one', () => {
      assert.equal(hintOfSecret('abcdefghijklmnop'), 'mnop');
      assert.equal(hintOfSecret('short'), null);
    });

    test('its key is derived with its own domain label, so it is not the deployment vault\'s key', () => {
      const src = read('src/lib/secrets/tenant-vault.ts');
      assert.match(src, /tenant-vault:v1:/);
      assert.match(src, /setAAD\(aad\(context\)\)/);
    });

    test('the database never receives a plaintext and a session can never read the secret material', () => {
      assert.match(sql, /revoke all on table crm\.connector_credentials from public, anon, authenticated;\ngrant select \(id, organization_id, integration_id, name, hint, expires_on, status, created_by, created_at, rotated_at, revoked_at\)/);
      const grant = sql.slice(sql.indexOf('grant select (id, organization_id, integration_id, name, hint'), sql.indexOf('on crm.connector_credentials to authenticated'));
      for (const col of ['ciphertext', 'iv', 'auth_tag']) assert.doesNotMatch(grant, new RegExp(col));
      const door = fn('crm.store_connector_secret');
      assert.doesNotMatch(door, /plaintext|p_value/);
      assert.match(door, /core\.is_owner\(\)/);
      assert.doesNotMatch(door, /record_audit\([^;]*p_ciphertext/);
    });
  });

  describe('the registry never overstates what has been proven', () => {
    test('no adapter has been written, and none is registered: every provider is NOT_IMPLEMENTED today', () => {
      assert.deepEqual(Object.keys(ADAPTERS), []);
    });

    test('verification can only be moved by the doors: a trigger refuses any other write', () => {
      const guard = fn('crm.integration_write_guard');
      for (const col of ['status', 'verification', 'adapter_implemented', 'capabilities', 'account_ref', 'last_success_at']) assert.match(guard, new RegExp(`new\\.${col} is distinct from old\\.${col}`), col);
      assert.match(guard, /current_setting\('crm\.integration_write', true\)/);
      for (const door of ['crm.record_integration_check', 'crm.store_connector_secret', 'crm.set_integration_state', 'crm.sync_integration_adapter']) {
        assert.match(fn(door), /set_config\('crm\.integration_write', '1', true\)/, door);
      }
    });

    test('a check on a provider with no adapter is refused, and verified states come only from a passing real check', () => {
      const body = fn('crm.record_integration_check');
      assert.match(body, /if not i\.adapter_implemented then return query select 'no_adapter'/);
      assert.match(body, /'LIVE_VERIFIED' else 'SANDBOX_VERIFIED'/);
      assert.match(body, /i\.environment = 'production'/);
      assert.match(sql, /revoke all on function crm\.record_integration_check\([^)]*\) from public, anon, authenticated/);
    });

    test('the SQL and TypeScript vocabularies are the same lists', () => {
      assert.deepEqual(listIn(sql.match(/verification\s+text not null default 'NOT_IMPLEMENTED' check \(verification in\s*\(([^)]*)\)/)?.[1] ?? ''), [...VERIFICATION_STATES]);
      assert.deepEqual(new Set(listIn(sql.match(/v_key not in \(([^)]*)\)/)?.[1] ?? '')), new Set(CAPABILITIES));
      assert.deepEqual(new Set(listIn(sql.match(/v_val not in \(([^)]*)\)/)?.[1] ?? '')), new Set(CAPABILITY_MODES));
      for (const v of VERIFICATION_STATES) assert.ok(VERIFICATION_WORDS[v], `${v} has words`);
    });

    test('every provider is in the catalogue and in the SQL provider_type function, with the same kind', () => {
      const body = fn('crm.provider_type');
      for (const p of PROVIDERS) {
        assert.ok(PROVIDER_CATALOG[p], p);
        const kind = PROVIDER_CATALOG[p].kind;
        const arm = new RegExp(`when [^\\n]*'${p}'[^\\n]* then '${kind}'`);
        assert.match(body, arm, `${p} -> ${kind}`);
      }
    });

    test('the catalogue makes no claim about what a provider\'s API can do', () => {
      const src = read('src/modules/acquisition/providers.ts');
      assert.doesNotMatch(src, /expectedCapabilities|supportsPublish|canSubmit/);
    });
  });

  describe('error classification and retry (spec §53, §129)', () => {
    test('classifies transient, permanent, conditional and security', () => {
      assert.equal(classifyProviderError({ timedOut: true }), 'transient');
      assert.equal(classifyProviderError({ networkError: true }), 'transient');
      assert.equal(classifyProviderError({ status: 429 }), 'transient');
      assert.equal(classifyProviderError({ status: 503 }), 'transient');
      assert.equal(classifyProviderError({ status: 400 }), 'permanent');
      assert.equal(classifyProviderError({ status: 404 }), 'permanent');
      assert.equal(classifyProviderError({ status: 401 }), 'conditional');
      assert.equal(classifyProviderError({ status: 403 }), 'conditional');
      assert.equal(classifyProviderError({ credentialExpired: true }), 'conditional');
      assert.equal(classifyProviderError({ signatureInvalid: true, status: 200 }), 'security');
      assert.equal(classifyProviderError({ tenantMismatch: true, status: 500 }), 'security', 'security outranks a retryable status');
    });

    test('only a transient failure is retried automatically', () => {
      assert.deepEqual((['transient', 'permanent', 'conditional', 'security'] as const).filter(isRetryable), ['transient']);
    });

    test('backoff grows exponentially with jitter, is capped, and never undercuts Retry-After', () => {
      const top = () => 0.999999;
      const bottom = () => 0;
      assert.ok(backoffSeconds(1, { random: top }) <= 30);
      assert.ok(backoffSeconds(3, { random: top }) <= 120 && backoffSeconds(3, { random: top }) > 60);
      assert.ok(backoffSeconds(30, { random: top }) <= 3600, 'capped');
      assert.equal(backoffSeconds(1, { random: bottom }), 1, 'jitter never returns zero');
      assert.equal(backoffSeconds(1, { random: bottom, retryAfterSeconds: 90 }), 90, 'Retry-After is a floor');
      assert.equal(backoffSeconds(1, { random: top, retryAfterSeconds: 999999 }), 3600, 'Retry-After is capped too');
      let last = 0;
      for (let a = 1; a <= 6; a += 1) { const v = backoffSeconds(a, { random: top }); assert.ok(v >= last); last = v; }
    });
  });

  describe('the policy decision', () => {
    test('the action list and the never-auto list are the same in SQL and TypeScript', () => {
      const actions = listIn(sql.match(/action_type\s+text not null check \(action_type in \(([^)]*)\)\)/)?.[1] ?? '');
      assert.deepEqual(actions, [...ACTION_TYPES]);
      const gate = listIn(sql.match(/check \(mode <> 'auto' or action_type not in\s*\(([^)]*)\)\)/)?.[1] ?? '');
      assert.deepEqual(new Set(gate), new Set(NEVER_AUTO));
      for (const a of NEVER_AUTO) assert.ok(fn('crm.set_acquisition_policy').includes(`'${a}'`), `${a} in the door's own refusal`);
    });

    test('the order is: stops, then the connector, then the limits, then the policy - and no policy is never permission', () => {
      const body = fn('crm.acquisition_decide');
      const order = ['crm.acquisition_blocked(', 'crm.required_providers(', "'daily_limit'", "'monthly_budget_exceeded'", "'no_policy_default'", "'AUTO_APPROVE'"];
      let at = -1;
      for (const marker of order) { const i = body.indexOf(marker, at + 1); assert.ok(i > at, `${marker} out of order`); at = i; }
      assert.match(body, /d := 'ADMIN_APPROVAL_REQUIRED'; r := 'no_policy_default'/);
      assert.match(body, /'unknown_action'/);
      assert.match(body, /'tenant_mismatch'/);
    });

    test('a spend cap is a cap: approval cannot lift it, and the decision is logged', () => {
      const body = fn('crm.acquisition_decide');
      assert.match(body, /d := 'BLOCK'; r := 'monthly_budget_exceeded'/);
      assert.match(body, /insert into crm\.acquisition_decisions/);
    });

    test('loosening governance is owner-only and the policy table stays fully audited', () => {
      const body = fn('crm.set_acquisition_policy');
      assert.match(body, /v_loosens and not coalesce\(\(select core\.is_owner\(\)\), false\)/);
      assert.match(body, /acquisition\.policy_changed/);
    });

    test('the TypeScript wrapper treats a missing answer as BLOCK, never as permission', async () => {
      const none = { schema: () => ({ rpc: async () => ({ data: null, error: null }) }) } as never;
      const d = await decideAction(none, { organizationId: 'o', action: 'email_outreach' });
      assert.equal(d.decision, 'BLOCK');
      const garbage = { schema: () => ({ rpc: async () => ({ data: [{}], error: null }) }) } as never;
      assert.equal((await decideAction(garbage, { organizationId: 'o', action: 'email_outreach' })).decision, 'BLOCK');
    });
  });

  describe('approvals bound to the exact content', () => {
    test('the hash is canonical: key order does not matter, any change does', () => {
      const a = { title: 'Launch post', body: 'Hello', tags: ['a', 'b'], meta: { x: 1, y: 2 } };
      const reordered = { meta: { y: 2, x: 1 }, tags: ['a', 'b'], body: 'Hello', title: 'Launch post' };
      assert.equal(contentHash(a), contentHash(reordered));
      assert.match(contentHash(a), /^[0-9a-f]{64}$/);
      for (const changed of [{ ...a, body: 'Hello!' }, { ...a, tags: ['b', 'a'] }, { ...a, meta: { x: 1, y: 3 } }, { ...a, extra: 1 }]) {
        assert.notEqual(contentHash(changed), contentHash(a));
      }
      assert.equal(contentHash({ a: 1, b: undefined }), contentHash({ a: 1 }), 'undefined is dropped');
      assert.notEqual(canonicalJson('1'), canonicalJson(1), 'a string and a number differ');
    });

    test('the approval engine has the four new subject types in the CHECKs, the TypeScript list and both screens', () => {
      for (const t of ['social_content', 'b2b_proposal', 'ad_campaign', 'acquisition_action']) {
        assert.ok((APPROVAL_SUBJECT_TYPES as readonly string[]).includes(t), `${t} in schema.ts`);
        assert.equal((sql.match(new RegExp(`'${t}'`, 'g')) ?? []).length >= 2, true, `${t} in both CHECKs`);
        for (const page of ['app/(internal)/approvals/page.tsx', 'app/(internal)/approvals/[requestId]/page.tsx']) assert.match(read(page), new RegExp(`${t}: '`), `${t} labelled in ${page}`);
      }
    });

    test('an artifact id names ONE immutable version: the same id with other content is refused', () => {
      assert.match(fn('crm.bind_approval'), /v_prior <> p_content_hash then\s+return query select 'content_changed'/);
      assert.match(sql, /before update or delete on crm\.approval_bindings for each row execute function crm\.history_only\(\)/);
    });

    test('approval_check compares state, artifact, hash and validity - in that order - and reads fresh every call', () => {
      const body = fn('crm.approval_check');
      const order = ["'no_binding'", "'state_'", "'artifact_mismatch'", "'content_changed'", "'expired'"];
      let at = -1;
      for (const marker of order) { const i = body.indexOf(marker, at + 1); assert.ok(i > at, `${marker} out of order`); at = i; }
      assert.match(body, /language plpgsql\nstable/);
    });

    test('the one execution door re-reads the pause and the approval BEFORE it reserves anything, and reserves once per approval', () => {
      const body = fn('crm.begin_governed_execution');
      const a = body.indexOf('crm.acquisition_blocked(');
      const b = body.indexOf('crm.approval_check(');
      const c = body.indexOf('insert into crm.governed_executions');
      assert.ok(a > 0 && b > a && c > b, 'pause, approval, then reserve');
      assert.match(sql, /unique \(approval_request_id\)/);
      assert.match(body, /on conflict \(approval_request_id\) do nothing/);
      assert.match(body, /'already_executed'/);
      assert.match(body, /'needs_reconciliation'/);
      assert.match(body, /e\.attempt >= 3 then return query select 'exhausted'/);
    });

    test('an uncertain outcome is never silently re-run: unknown and stalled executions need reconciliation', () => {
      const guard = fn('crm.governed_execution_guard');
      assert.match(guard, /old\.status = 'unknown'\s+and new\.status in \('executed', 'failed'\)/);
      assert.doesNotMatch(guard, /old\.status = 'unknown'\s+and new\.status = 'executing'/);
      assert.match(fn('crm.begin_governed_execution'), /e\.started_at < now\(\) - interval '10 minutes'/);
    });

    test('APPROVED, EXECUTED and VERIFIED are different states on different rows', () => {
      assert.match(sql, /status\s+text not null default 'executing' check \(status in \('executing', 'executed', 'verified', 'failed', 'unknown'\)\)/);
      assert.match(fn('crm.verify_governed_execution'), /if e\.status <> 'executed' then return query select 'wrong_state'/);
    });

    test('the execution door is service-role only and the TypeScript wrapper only ever proceeds on "proceed"', async () => {
      assert.match(sql, /revoke all on function crm\.begin_governed_execution\([^)]*\) from public, anon, authenticated/);
      const answer = (data: unknown) => ({ schema: () => ({ rpc: async () => ({ data, error: null }) }) }) as never;
      const input = { organizationId: 'o', requestId: 'r', artifactType: 'social_content', artifactId: 'a', contentHash: 'h', action: 'social_publish' } as const;
      assert.equal((await beginExecution(answer([{ outcome: 'proceed', reason: 'first_execution', execution_id: 'e1' }]), input)).outcome, 'proceed');
      assert.equal((await beginExecution(answer(null), input)).outcome, 'blocked', 'no answer is not permission');
      assert.equal((await beginExecution(answer([{}]), input)).outcome, 'blocked');
      assert.equal((await beginExecution(answer([{ outcome: 'already_executed', execution_id: 'e1' }]), input)).outcome, 'already_executed');
    });
  });

  describe('tenancy and privileges', () => {
    test('every new table revokes the platform default privileges, is frozen to its organisation and forces RLS', () => {
      for (const t of ['acquisition_integrations', 'connector_credentials', 'acquisition_policies', 'acquisition_usage', 'acquisition_decisions', 'approval_bindings', 'governed_executions']) {
        assert.match(sql, new RegExp(`revoke all on table crm\\.${t} from public, anon, authenticated`), `${t} revoke`);
        assert.match(sql, new RegExp(`create trigger freeze_org_${t} before update of organization_id on crm\\.${t}`), `${t} freeze`);
        assert.match(sql, new RegExp(`alter table crm\\.${t} force row level security`), `${t} force`);
      }
      for (const g of ['org_match_connector_credentials_integration', 'org_match_approval_bindings_request', 'org_match_governed_executions_request']) assert.match(sql, new RegExp(`create trigger ${g}`), g);
    });

    test('the ledgers and the decision log are append-only', () => {
      for (const t of ['acquisition_usage', 'acquisition_decisions', 'approval_bindings']) {
        assert.match(sql, new RegExp(`create trigger ${t}_immutable before update or delete on crm\\.${t}`), t);
      }
    });
  });
});
