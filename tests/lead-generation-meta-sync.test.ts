import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

const SECRET = 'test-vault-secret-test-vault-secret-0123456789';
mock.module('@/lib/env', { namedExports: { serverEnv: () => ({ VAULT_ENCRYPTION_KEY: SECRET }) } });

const { sealForTenant } = await import('../src/lib/secrets/tenant-vault.ts');
const { syncMetaAdMetrics, spendToMinor } = await import('../src/modules/acquisition/meta-metrics-sync.ts');

const ORG = 'org-1';
const INTEG = 'int-1';
const TOKEN = 'EAAtoken-must-never-leave-the-process';
const sealed = sealForTenant(TOKEN, { organizationId: ORG, integrationId: INTEG, name: 'access_token' }, SECRET);

type Rpc = { schema: string; fn: string; args: Record<string, unknown> };

/** A stand-in for the service-role client: every query chain resolves to the canned rows of its table, and every door is recorded. */
function world(tables: Record<string, unknown>) {
  const rpcs: Rpc[] = [];
  const admin = {
    schema: (schema: string) => ({
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        const rows = tables[table];
        const settle = () => Promise.resolve({ data: rows ?? [], error: null });
        for (const m of ['select', 'eq', 'order', 'limit', 'in', 'not']) chain[m] = () => chain;
        chain.maybeSingle = () => Promise.resolve({ data: Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null), error: null });
        chain.then = (res: (v: unknown) => unknown) => settle().then(res);
        return chain;
      },
      rpc: (fn: string, args: Record<string, unknown>) => { rpcs.push({ schema, fn, args }); return Promise.resolve({ data: [{ outcome: 'recorded' }], error: null }); },
    }),
  };
  return { admin: admin as never, rpcs };
}

const INTEGRATIONS = [{ id: INTEG, organization_id: ORG }];
const LAUNCHED = [{ provider_campaign_id: '120330000000000001', version_id: 'v1', ad_campaign_versions: { campaign_id: 'camp-1', ad_campaigns: { id: 'camp-1', platform: 'meta_ads', currency: 'INR', status: 'live' } } }];
const CRED = { name: 'access_token', ciphertext: sealed.ciphertext, iv: sealed.iv, auth_tag: sealed.authTag };
const day = (date: string, spend: string, extra: Record<string, unknown> = {}) => ({ date, spend, impressions: 1000, clicks: 20, leads: 3, ...extra });

describe('lead generation - Meta figures are recorded through the same door a hand-copied figure uses', () => {
  test('a launched campaign\'s days are recorded once each, spend in minor units, with the platform\'s lead claim kept apart', async () => {
    const w = world({ acquisition_integrations: INTEGRATIONS, ad_applications: LAUNCHED, connector_credentials: CRED, ad_metrics: null });
    const seen: { token: string }[] = [];
    const out = await syncMetaAdMetrics(w.admin, { now: new Date('2026-10-07T10:00:00Z'), read: async (i) => { seen.push({ token: i.token }); return { ok: true, currency: 'INR', days: [day('2026-10-05', '123.45'), day('2026-10-06', '10.00')] }; } });
    assert.equal(out.recorded, 2);
    assert.deepEqual(seen, [{ token: TOKEN }]);
    const calls = w.rpcs.filter((r) => r.fn === 'record_ad_metrics');
    assert.equal(calls.length, 2);
    assert.deepEqual([calls[0]!.args.p_spend_minor, calls[0]!.args.p_platform_leads, calls[0]!.args.p_campaign, calls[0]!.args.p_organization_id], [12345, 3, 'camp-1', ORG]);
  });

  test('a figure that has not changed is not recorded again (the ledger is append-only)', async () => {
    const w = world({ acquisition_integrations: INTEGRATIONS, ad_applications: LAUNCHED, connector_credentials: CRED, ad_metrics: { spend_minor: 12345, impressions: 1000, clicks: 20, platform_leads: 3 } });
    const out = await syncMetaAdMetrics(w.admin, { read: async () => ({ ok: true, currency: 'INR', days: [day('2026-10-05', '123.45')] }) });
    assert.deepEqual([out.recorded, out.unchanged], [0, 1]);
    assert.equal(w.rpcs.filter((r) => r.fn === 'record_ad_metrics').length, 0);
  });

  test('with nothing recorded as launched, Meta is never called', async () => {
    const w = world({ acquisition_integrations: INTEGRATIONS, ad_applications: [], connector_credentials: CRED });
    let called = 0;
    const out = await syncMetaAdMetrics(w.admin, { read: async () => { called += 1; return { ok: true, currency: 'INR', days: [] }; } });
    assert.equal(called, 0);
    assert.equal(out.campaigns, 0);
    assert.equal(out.connections, 0, 'the vault is not even opened when there is nothing to read');
  });

  test('a draft campaign, or one on another platform, is not read', async () => {
    const draft = [{ ...LAUNCHED[0]!, ad_campaign_versions: { campaign_id: 'c', ad_campaigns: { id: 'c', platform: 'meta_ads', currency: 'INR', status: 'draft' } } }];
    const google = [{ ...LAUNCHED[0]!, ad_campaign_versions: { campaign_id: 'c', ad_campaigns: { id: 'c', platform: 'google_ads', currency: 'INR', status: 'live' } } }];
    for (const apps of [draft, google]) {
      let called = 0;
      await syncMetaAdMetrics(world({ acquisition_integrations: INTEGRATIONS, ad_applications: apps, connector_credentials: CRED }).admin, { read: async () => { called += 1; return { ok: true, currency: 'INR', days: [] }; } });
      assert.equal(called, 0);
    }
  });

  test('a currency mismatch or a currency without hundredths is refused, never converted by guessing', async () => {
    for (const currency of ['USD', 'JPY']) {
      const w = world({ acquisition_integrations: INTEGRATIONS, ad_applications: LAUNCHED, connector_credentials: CRED, ad_metrics: null });
      const out = await syncMetaAdMetrics(w.admin, { read: async () => ({ ok: true, currency, days: [day('2026-10-05', '50.00')] }) });
      assert.equal(out.recorded, 0, currency);
      assert.equal(out.skipped, 1);
      assert.equal(w.rpcs.filter((r) => r.fn === 'record_ad_metrics').length, 0);
      assert.ok(w.rpcs.some((r) => r.fn === 'raise_alert'));
    }
  });

  test('a credential problem tells a person; a transient failure only retries next time; neither records a figure or leaks the token', async () => {
    const perm = world({ acquisition_integrations: INTEGRATIONS, ad_applications: LAUNCHED, connector_credentials: CRED });
    const a = await syncMetaAdMetrics(perm.admin, { read: async () => ({ ok: false, errorClass: 'conditional', message: 'Meta said: expired' }) });
    assert.equal(a.failed, 1);
    const alert = perm.rpcs.find((r) => r.fn === 'raise_alert');
    assert.ok(alert);
    assert.ok(!JSON.stringify(perm.rpcs).includes(TOKEN));
    const trans = world({ acquisition_integrations: INTEGRATIONS, ad_applications: LAUNCHED, connector_credentials: CRED });
    await syncMetaAdMetrics(trans.admin, { read: async () => ({ ok: false, errorClass: 'transient', message: 'Could not reach Meta.' }) });
    assert.ok(!trans.rpcs.some((r) => r.fn === 'raise_alert'));
  });

  test('a stored credential that will not open is reported as a problem, and Meta is not called', async () => {
    const w = world({ acquisition_integrations: INTEGRATIONS, ad_applications: LAUNCHED, connector_credentials: { ...CRED, ciphertext: 'AAAA' } });
    let called = 0;
    const out = await syncMetaAdMetrics(w.admin, { read: async () => { called += 1; return { ok: true, currency: 'INR', days: [] }; } });
    assert.equal(called, 0);
    assert.equal(out.failed, 1);
  });

  test('only an ACTIVE and LIVE_VERIFIED connection is asked for (the query says so)', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../src/modules/acquisition/meta-metrics-sync.ts', import.meta.url), 'utf8');
    assert.match(src, /eq\('status', 'active'\)\.eq\('verification', 'LIVE_VERIFIED'\)/);
    assert.doesNotMatch(src, /method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  });

  test('the job runner calls it every fifteenth minute, and a failure is logged and ignored', async () => {
    const route = (await import('node:fs')).readFileSync(new URL('../app/api/jobs/run/route.ts', import.meta.url), 'utf8');
    assert.match(route, /Math\.floor\(Date\.now\(\) \/ 60_000\) % 15 === 0/);
    assert.match(route, /await syncMetaAdMetrics\(admin\)/);
    assert.match(route, /meta metrics: /);
  });

  test('spend is turned into minor units exactly, and a value that is not a plain decimal is refused', () => {
    assert.equal(spendToMinor('123.45'), 12345);
    assert.equal(spendToMinor('0.00'), 0);
    assert.equal(spendToMinor('1000'), 100000);
    assert.equal(spendToMinor('12.345'), 1235);
    assert.equal(spendToMinor('-5'), null);
    assert.equal(spendToMinor('1e5'), null);
    assert.equal(spendToMinor(''), null);
  });
});
