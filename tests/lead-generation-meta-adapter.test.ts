import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { createMetaAdsAdapter, normaliseAdAccountId, type MetaFetch } from '../src/modules/acquisition/meta-ads-adapter.ts';

const TOKEN = 'EAAtest-token-that-must-never-appear-in-any-output';
type Reply = { status: number; body: unknown } | 'throw' | 'abort';

/** A stand-in for Graph: answers by path and records every call so the test can see exactly what was asked, and how. */
function graph(replies: Record<string, Reply>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: MetaFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const key = Object.keys(replies).find((k) => url.includes(k));
    const r = key ? replies[key]! : { status: 404, body: { error: { message: 'unknown path' } } };
    if (r === 'throw') throw new Error('ECONNRESET');
    if (r === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    return { status: r.status, json: async () => r.body };
  };
  return { calls, adapter: createMetaAdsAdapter({ fetcher, baseUrl: 'https://graph.test' }) };
}
const ctx = (cred: Record<string, string>) => ({ environment: 'production' as const, credential: (n: string) => cred[n] ?? null, signal: new AbortController().signal });
const GOOD = { 'me?fields': { status: 200, body: { id: '1', name: 'AgencyOs' } }, 'me/permissions': { status: 200, body: { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'granted' }] } }, 'act_604071818551620': { status: 200, body: { id: 'act_604071818551620', name: 'Main', account_status: 1, currency: 'INR' } } } as const;
const CRED = { access_token: TOKEN, ad_account_id: 'act_604071818551620' };
const GOOD_FOR_604 = GOOD;

describe('lead generation - the Meta Ads adapter (read-only)', () => {
  test('a good token and a reachable active account verify, naming the account and what it proved', async () => {
    const { adapter } = graph(GOOD_FOR_604);
    const r = await adapter.testConnection(ctx(CRED));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.accountRef, /act_604071818551620 · Main · INR/);
      assert.equal(r.capabilities.READ_AD_METRICS, 'AUTOMATED');
      assert.equal(r.apiVersion, 'v25.0');
    }
  });

  test('it can never claim to launch or change a campaign: those are at most ASSISTED, and UNAVAILABLE without ads_management', async () => {
    const withMgmt = await graph(GOOD_FOR_604).adapter.testConnection(ctx(CRED));
    const readOnly = await graph({ ...GOOD_FOR_604, 'me/permissions': { status: 200, body: { data: [{ permission: 'ads_read', status: 'granted' }] } } }).adapter.testConnection(ctx(CRED));
    assert.ok(withMgmt.ok && readOnly.ok);
    if (withMgmt.ok && readOnly.ok) {
      for (const c of ['CREATE_CAMPAIGN', 'UPDATE_CAMPAIGN'] as const) {
        assert.equal(withMgmt.capabilities[c], 'ASSISTED');
        assert.equal(readOnly.capabilities[c], 'UNAVAILABLE');
        assert.notEqual(withMgmt.capabilities[c], 'AUTOMATED');
      }
    }
  });

  test('every call is a GET with the token in the Authorization header, never in the URL', async () => {
    const { adapter, calls } = graph(GOOD_FOR_604);
    await adapter.testConnection(ctx(CRED));
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
      assert.ok(!c.url.includes(TOKEN) && !c.url.includes('access_token'));
    }
  });

  test('an expired or invalid token is a credential problem (conditional), and the token is not in the message', async () => {
    const r = await graph({ 'me?fields': { status: 401, body: { error: { message: 'Error validating access token: Session has expired' } } } }).adapter.testConnection(ctx(CRED));
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.errorClass, 'conditional'); assert.ok(!r.message.includes(TOKEN)); }
  });

  test('a token without ads_read or ads_management is refused, and says which app to generate it from', async () => {
    const r = await graph({ ...GOOD_FOR_604, 'me/permissions': { status: 200, body: { data: [{ permission: 'business_management', status: 'granted' }, { permission: 'ads_read', status: 'declined' }] } } }).adapter.testConnection(ctx(CRED));
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.errorClass, 'conditional'); assert.match(r.message, /Marketing API use case/); }
  });

  test('an ad account that is not assigned to the system user fails with the reason, not a pass', async () => {
    const r = await graph({ 'me?fields': GOOD['me?fields'], 'me/permissions': GOOD['me/permissions'], 'act_604071818551620': { status: 403, body: { error: { message: 'Unsupported get request. Object does not exist' } } } }).adapter.testConnection(ctx(CRED));
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.errorClass, 'conditional'); assert.match(r.message, /assigned to this system user/); }
  });

  test('an ad account that is disabled, unsettled or closed is not verified as usable', async () => {
    for (const status of [2, 3, 7, 101]) {
      const r = await graph({ ...GOOD_FOR_604, 'act_604071818551620': { status: 200, body: { id: 'x', name: 'Main', account_status: status, currency: 'INR' } } }).adapter.testConnection(ctx(CRED));
      assert.equal(r.ok, false, `status ${status}`);
    }
  });

  test('a network failure or a timeout is transient (retry), never a pass', async () => {
    for (const mode of ['throw', 'abort'] as const) {
      const r = await graph({ 'me?fields': mode }).adapter.testConnection(ctx(CRED));
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.errorClass, 'transient');
    }
  });

  test('an answer that is not the shape of an identity or an account verifies nothing', async () => {
    assert.equal((await graph({ 'me?fields': { status: 200, body: {} } }).adapter.testConnection(ctx(CRED))).ok, false);
    assert.equal((await graph({ ...GOOD_FOR_604, 'act_604071818551620': { status: 200, body: {} } }).adapter.testConnection(ctx(CRED))).ok, false);
  });

  test('a missing token or ad account makes no call at all', async () => {
    const { adapter, calls } = graph(GOOD_FOR_604);
    assert.equal((await adapter.testConnection(ctx({ ad_account_id: 'act_1234567' }))).ok, false);
    assert.equal((await adapter.testConnection(ctx({ access_token: TOKEN }))).ok, false);
    assert.equal((await adapter.testConnection(ctx({ access_token: TOKEN, ad_account_id: 'not-an-id' }))).ok, false);
    assert.equal(calls.length, 0);
  });

  test('an ad account id is accepted as Meta writes it or as it is copied', () => {
    assert.equal(normaliseAdAccountId('act_604071818551620'), 'act_604071818551620');
    assert.equal(normaliseAdAccountId(' 604071818551620 '), 'act_604071818551620');
    assert.equal(normaliseAdAccountId('act_12'), null);
    assert.equal(normaliseAdAccountId(null), null);
  });

  test('the adapter has no write: no POST, no method but GET, in the source', () => {
    const src = readFileSync(new URL('../src/modules/acquisition/meta-ads-adapter.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /method:\s*['"](POST|PUT|PATCH|DELETE)/i);
    assert.doesNotMatch(src, /\/campaigns|\/adsets|\/ads\b|\/adcreatives/i);
  });
});
