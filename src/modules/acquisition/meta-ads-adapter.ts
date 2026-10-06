import { classifyProviderError, type AdapterCheck, type Capability, type CapabilityMode, type ProviderAdapter } from './providers';

/**
 * The Meta (Facebook) Ads adapter - READ-ONLY, and says so.
 *
 * What it does: `testConnection` makes three real, read-only Graph API calls with the stored system-user token and reports what
 * they PROVED - the token is valid and who it belongs to, which permissions it was actually granted, and that the named ad account
 * is reachable and in what state. Nothing is created, changed, paused or spent. It cannot launch a campaign: that adapter does not
 * exist, and the capabilities it records say so (CREATE_CAMPAIGN / UPDATE_CAMPAIGN are at most ASSISTED - a person does the act
 * and records it - never AUTOMATED).
 *
 * The token travels in the Authorization header, never in a URL, and no message this file produces contains it.
 */

export const META_GRAPH_VERSION = 'v25.0';
const DEFAULT_BASE = 'https://graph.facebook.com';

export type MetaFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; type?: string } };

const failure = (errorClass: 'transient' | 'permanent' | 'conditional' | 'security', message: string): AdapterCheck => ({ ok: false, errorClass, message });

/** An ad account id as Meta writes it (`act_123`) or as a person copies it (`123`). */
export function normaliseAdAccountId(raw: string | null): string | null {
  const m = /^(?:act_)?(\d{6,20})$/.exec((raw ?? '').trim());
  return m ? `act_${m[1]}` : null;
}

/** Meta's `account_status`: 1 is active; the rest are states in which nothing can be run. */
const ACCOUNT_STATUS: Record<number, string> = {
  1: 'active', 2: 'disabled', 3: 'unsettled (a payment is overdue)', 7: 'pending risk review', 8: 'pending settlement', 9: 'in a grace period', 100: 'pending closure', 101: 'closed', 201: 'any active', 202: 'any closed',
};

export function createMetaAdsAdapter(options: { fetcher?: MetaFetch; baseUrl?: string } = {}): ProviderAdapter {
  const fetcher: MetaFetch = options.fetcher ?? ((url, init) => fetch(url, { headers: init.headers, signal: init.signal, cache: 'no-store' }));
  const base = options.baseUrl ?? DEFAULT_BASE;

  async function get(path: string, token: string, signal: AbortSignal): Promise<{ status: number; body: unknown } | { networkError: true; timedOut: boolean }> {
    try {
      const res = await fetcher(`${base}/${META_GRAPH_VERSION}/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    } catch (e) {
      return { networkError: true, timedOut: e instanceof Error && e.name === 'AbortError' };
    }
  }

  const providerMessage = (body: unknown): string => {
    const e = (body as GraphError | null)?.error;
    // Meta's own words are kept (they name the cause) but cut short; they never contain the token.
    return e?.message ? `Meta said: ${e.message}`.slice(0, 300) : 'Meta refused the request.';
  };

  return {
    provider: 'meta_ads',
    async testConnection({ credential, signal }) {
      const token = credential('access_token');
      if (!token) return failure('conditional', 'No access token is stored. Store the system-user token as "access_token".');
      const account = normaliseAdAccountId(credential('ad_account_id'));
      if (!account) return failure('conditional', 'No ad account is stored. Store its id (for example act_1234567890) as "ad_account_id".');

      // 1. Who does this token belong to? A bad or expired token fails here, before anything else is claimed.
      const me = await get('me?fields=id,name', token, signal);
      if ('networkError' in me) return failure('transient', me.timedOut ? 'Meta did not answer in time.' : 'Could not reach Meta.');
      if (me.status !== 200) return failure(classifyProviderError({ status: me.status, credentialExpired: me.status === 401 }), providerMessage(me.body));
      const identity = me.body as { id?: string; name?: string } | null;
      if (!identity?.id) return failure('permanent', 'Meta answered, but not with an identity. Nothing was verified.');

      // 2. What was the token actually granted? (Not what the person intended to tick.)
      const perms = await get('me/permissions', token, signal);
      if ('networkError' in perms) return failure('transient', perms.timedOut ? 'Meta did not answer in time.' : 'Could not reach Meta.');
      if (perms.status !== 200) return failure(classifyProviderError({ status: perms.status }), providerMessage(perms.body));
      const granted = new Set(((perms.body as { data?: { permission?: string; status?: string }[] } | null)?.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission ?? ''));
      const canRead = granted.has('ads_read') || granted.has('ads_management');
      if (!canRead) return failure('conditional', 'The token was not granted ads_read or ads_management. Generate it again from the app that has the Marketing API use case, and tick them.');

      // 3. Is the named ad account reachable with this token, and in what state?
      const acc = await get(`${account}?fields=name,account_status,currency,disable_reason`, token, signal);
      if ('networkError' in acc) return failure('transient', acc.timedOut ? 'Meta did not answer in time.' : 'Could not reach Meta.');
      if (acc.status !== 200) {
        const permissionMissing = acc.status === 400 || acc.status === 403;
        return failure(permissionMissing ? 'conditional' : classifyProviderError({ status: acc.status }), `${providerMessage(acc.body)} (Is ${account} assigned to this system user, with the app, in Business settings?)`.slice(0, 380));
      }
      const info = acc.body as { id?: string; name?: string; account_status?: number; currency?: string } | null;
      if (!info?.name) return failure('permanent', 'Meta answered, but not with the ad account. Nothing was verified.');
      if (info.account_status !== 1) {
        return failure('conditional', `The ad account ${account} is ${ACCOUNT_STATUS[info.account_status ?? -1] ?? `in state ${info.account_status}`}, so nothing can run on it. Fix it in Meta first.`);
      }

      const capabilities: Partial<Record<Capability, CapabilityMode>> = {
        // Proven just now: the account answered with ads_read or ads_management.
        READ_AD_METRICS: 'AUTOMATED',
        // NOT built: a person applies an approved plan on Meta and records it. Never AUTOMATED from this adapter.
        CREATE_CAMPAIGN: granted.has('ads_management') ? 'ASSISTED' : 'UNAVAILABLE',
        UPDATE_CAMPAIGN: granted.has('ads_management') ? 'ASSISTED' : 'UNAVAILABLE',
      };
      return { ok: true, accountRef: `${account} · ${info.name} · ${info.currency ?? '?'}`.slice(0, 200), capabilities, apiVersion: META_GRAPH_VERSION };
    },
  };
}
