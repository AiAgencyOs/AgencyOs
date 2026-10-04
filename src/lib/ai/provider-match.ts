/**
 * The Provider Manager's pure rules - no database, no network, no `server-only`, so the same code runs in the
 * runtime, on the Admin screen and in a unit test.
 *
 *   • how a provider recognises a model (prefixes and fragments - plain strings, never a pattern),
 *   • which of a provider's keys may be tried right now and in what order,
 *   • what a given failure means for the key that produced it.
 */

export const PROVIDER_KINDS = ['anthropic', 'openai_compat', 'anthropic_compat'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const HEALTH_STATES = ['unknown', 'healthy', 'degraded', 'rate_limited', 'quota_exhausted', 'auth_error', 'unavailable'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export type ProviderMatchRule = { readonly prefixes: readonly string[]; readonly contains: readonly string[] };

/** A model belongs to a provider when its id starts with one of its prefixes or contains one of its fragments. */
export function modelMatches(rule: ProviderMatchRule, model: string): boolean {
  const m = model.trim();
  if (m === '') return false;
  return rule.prefixes.some((p) => p !== '' && m.startsWith(p)) || rule.contains.some((c) => c !== '' && m.includes(c));
}

export type KeyState = {
  readonly enabled: boolean;
  readonly health: HealthState;
  readonly priority: number;
  readonly cooldownUntil: Date | null;
  readonly label: string;
};

export type KeyEligibility = { usable: true } | { usable: false; reason: 'disabled' | 'auth_error' | 'cooling_down' };

/**
 * Whether a key may be tried now.
 *
 * An `auth_error` key is NEVER tried again until a person rotates or re-enables it (the database clears the state then):
 * a rejected key does not become good by being retried, and every retry is a call a vendor may count against the account.
 * A rate-limited or quota-exhausted key rests until its cooldown ends.
 */
export function keyEligibility(key: KeyState, now: Date): KeyEligibility {
  if (!key.enabled) return { usable: false, reason: 'disabled' };
  if (key.health === 'auth_error') return { usable: false, reason: 'auth_error' };
  if (key.cooldownUntil && key.cooldownUntil.getTime() > now.getTime()) return { usable: false, reason: 'cooling_down' };
  return { usable: true };
}

/** The usable keys, best first: lower priority number, then healthy before unknown before degraded, then label (deterministic). */
export function orderUsableKeys<T extends KeyState>(keys: readonly T[], now: Date): T[] {
  const rank: Record<HealthState, number> = { healthy: 0, unknown: 1, degraded: 2, rate_limited: 3, quota_exhausted: 3, unavailable: 4, auth_error: 5 };
  return keys
    .filter((k) => keyEligibility(k, now).usable)
    .sort((a, b) => a.priority - b.priority || rank[a.health] - rank[b.health] || a.label.localeCompare(b.label));
}

export type FailureKindName = 'auth' | 'rate_limit' | 'model_missing' | 'server' | 'timeout' | 'network';

export type KeyConsequence = {
  /** What the key's health becomes. */
  readonly keyKind: 'auth' | 'rate_limit' | 'quota' | 'unavailable' | 'other';
  /** Another KEY of the same provider may serve this request. */
  readonly tryNextKey: boolean;
  readonly cooldownSeconds: number;
  /** What the provider's health becomes. */
  readonly providerState: HealthState;
};

/**
 * What a failure means for the key that produced it. Only the failures that are about THE KEY rotate to another key:
 * a rejected key and a rate-limited key. A missing model, a vendor outage or a timeout would fail the same on every key
 * of this vendor, so rotating through them would only burn calls.
 */
export function consequenceOf(kind: FailureKindName | null, message = ''): KeyConsequence {
  const quota = /quota|billing|insufficient[_ ]funds|credit/i.test(message);
  switch (kind) {
    case 'auth':
      return { keyKind: 'auth', tryNextKey: true, cooldownSeconds: 0, providerState: 'auth_error' };
    case 'rate_limit':
      return quota
        ? { keyKind: 'quota', tryNextKey: true, cooldownSeconds: 3600, providerState: 'quota_exhausted' }
        : { keyKind: 'rate_limit', tryNextKey: true, cooldownSeconds: 60, providerState: 'rate_limited' };
    case 'model_missing':
      return { keyKind: 'other', tryNextKey: false, cooldownSeconds: 0, providerState: 'degraded' };
    case 'server':
    case 'timeout':
    case 'network':
      // A vendor outage is not about the key: resting the key would turn one failed call into "no usable key" for every call after it.
      return { keyKind: 'unavailable', tryNextKey: false, cooldownSeconds: 0, providerState: 'unavailable' };
    default:
      return { keyKind: 'other', tryNextKey: false, cooldownSeconds: 0, providerState: 'degraded' };
  }
}

/** A masked label for a stored key: its last four characters if it recorded them, never more. */
export function maskedKey(hint: string | null): string {
  return hint ? `••••••••••${hint}` : '••••••••••••';
}
