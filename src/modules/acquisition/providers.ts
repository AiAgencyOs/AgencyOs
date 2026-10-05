/**
 * The provider catalogue and the adapter contract (spec §55-§56, §77, §98, §129, §212).
 *
 * Client-safe and pure. It says what each provider IS and what credential it needs; it deliberately does NOT say what the
 * provider's API can do - that is a claim only a real adapter, running against the provider, can make, and it is recorded
 * per connection (capabilities, with a mode) by `crm.record_integration_check`. Nothing here is a promise about a provider.
 */

export const PROVIDERS = [
  'meta_ads', 'google_ads', 'facebook_page', 'instagram', 'linkedin', 'email_provider', 'hostinger', 'whatsapp', 'calendar',
  'upwork', 'freelancer', 'peopleperhour', 'guru', 'contra', 'fiverr', 'clutch', 'goodfirms', 'other',
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_ENVIRONMENTS = ['development', 'staging', 'production'] as const;

export type ProviderInfo = {
  label: string;
  kind: 'ads' | 'social' | 'email' | 'deployment' | 'messaging' | 'calendar' | 'marketplace' | 'directory' | 'other';
  /** The credential names an Admin enters, in order. Names only: these are what the adapter will ask the vault for. */
  credentials: readonly string[];
  /** One honest sentence about why a person has to act. */
  humanStep: string;
};

export const PROVIDER_CATALOG: Record<Provider, ProviderInfo> = {
  meta_ads: { label: 'Meta / Facebook Ads', kind: 'ads', credentials: ['access_token'], humanStep: 'A Meta Business account owner authorises the app and picks the ad account.' },
  google_ads: { label: 'Google Ads', kind: 'ads', credentials: ['developer_token', 'client_id', 'client_secret', 'refresh_token'], humanStep: 'A Google Ads manager authorises access and supplies the customer ID.' },
  facebook_page: { label: 'Facebook Page', kind: 'social', credentials: ['page_access_token'], humanStep: 'A Page admin authorises the app for the Page.' },
  instagram: { label: 'Instagram', kind: 'social', credentials: ['access_token'], humanStep: 'The Instagram professional account owner authorises the app.' },
  linkedin: { label: 'LinkedIn', kind: 'social', credentials: ['access_token'], humanStep: 'A LinkedIn page admin authorises the app (LinkedIn app review may apply).' },
  email_provider: { label: 'Email provider', kind: 'email', credentials: ['api_key'], humanStep: 'The mailbox or sending-service owner supplies a key.' },
  hostinger: { label: 'Hostinger', kind: 'deployment', credentials: ['api_token'], humanStep: 'The Hostinger account owner creates a scoped token.' },
  whatsapp: { label: 'WhatsApp Business', kind: 'messaging', credentials: ['access_token'], humanStep: 'Already configured under Keys & secrets for client messaging.' },
  calendar: { label: 'Calendar', kind: 'calendar', credentials: ['refresh_token'], humanStep: 'The calendar owner authorises access.' },
  upwork: { label: 'Upwork', kind: 'marketplace', credentials: ['access_token'], humanStep: 'The Upwork account owner authorises API access; availability depends on Upwork.' },
  freelancer: { label: 'Freelancer', kind: 'marketplace', credentials: ['access_token'], humanStep: 'The Freelancer account owner authorises API access.' },
  peopleperhour: { label: 'PeoplePerHour', kind: 'marketplace', credentials: ['api_key'], humanStep: 'The account owner supplies access; availability depends on the platform.' },
  guru: { label: 'Guru', kind: 'marketplace', credentials: ['api_key'], humanStep: 'The account owner supplies access; availability depends on the platform.' },
  contra: { label: 'Contra', kind: 'marketplace', credentials: ['api_key'], humanStep: 'The account owner supplies access; availability depends on the platform.' },
  fiverr: { label: 'Fiverr', kind: 'marketplace', credentials: ['api_key'], humanStep: 'The seller account owner supplies access; availability depends on the platform.' },
  clutch: { label: 'Clutch', kind: 'directory', credentials: ['api_key'], humanStep: 'The profile owner supplies access; availability depends on the directory.' },
  goodfirms: { label: 'GoodFirms', kind: 'directory', credentials: ['api_key'], humanStep: 'The profile owner supplies access; availability depends on the directory.' },
  other: { label: 'Other', kind: 'other', credentials: ['api_key'], humanStep: 'A person with access supplies a key.' },
};

export const CAPABILITIES = [
  'SEARCH', 'READ_PROFILE', 'READ_OPPORTUNITIES', 'READ_MESSAGES', 'SEND_MESSAGE', 'PUBLISH_CONTENT', 'READ_ANALYTICS',
  'CREATE_CAMPAIGN', 'UPDATE_CAMPAIGN', 'READ_AD_METRICS', 'SUBMIT_PROPOSAL', 'READ_PROPOSAL_STATUS', 'DEPLOY_PAGE', 'READ_DEPLOYMENT', 'CREATE_MEETING',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CAPABILITY_MODES = ['AUTOMATED', 'ASSISTED', 'MANUAL', 'UNAVAILABLE', 'DEGRADED'] as const;
export type CapabilityMode = (typeof CAPABILITY_MODES)[number];

export const VERIFICATION_STATES = [
  'NOT_IMPLEMENTED', 'IMPLEMENTED_NOT_CONFIGURED', 'CONFIGURED_NOT_VERIFIED', 'SANDBOX_VERIFIED', 'LIVE_VERIFIED', 'DEGRADED',
  'BLOCKED_BY_CREDENTIAL', 'BLOCKED_BY_PROVIDER', 'DISABLED',
] as const;
export type Verification = (typeof VERIFICATION_STATES)[number];

/** What each state means to a person, in the words the screen uses. */
export const VERIFICATION_WORDS: Record<Verification, { label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' | 'info'; meaning: string }> = {
  NOT_IMPLEMENTED: { label: 'Not built', tone: 'neutral', meaning: 'AgencyOS has no adapter for this provider yet, so nothing can use it - even with a key.' },
  IMPLEMENTED_NOT_CONFIGURED: { label: 'Needs a key', tone: 'warning', meaning: 'The adapter exists; no credential has been entered.' },
  CONFIGURED_NOT_VERIFIED: { label: 'Not tested', tone: 'warning', meaning: 'A credential is stored but the connection has not been tested.' },
  SANDBOX_VERIFIED: { label: 'Tested (sandbox)', tone: 'info', meaning: 'A test against a non-production account passed. It is not proof the live account works.' },
  LIVE_VERIFIED: { label: 'Verified', tone: 'success', meaning: 'A real check against the live account passed.' },
  DEGRADED: { label: 'Degraded', tone: 'warning', meaning: 'The last check failed in a way that may pass on retry.' },
  BLOCKED_BY_CREDENTIAL: { label: 'Credential problem', tone: 'danger', meaning: 'The credential is missing, expired or lacks a permission. A person must act.' },
  BLOCKED_BY_PROVIDER: { label: 'Provider limit', tone: 'danger', meaning: 'The provider refuses this - an approval, a plan or a policy. Not fixable by retrying.' },
  DISABLED: { label: 'Disabled', tone: 'neutral', meaning: 'Switched off by an admin. It must be re-tested before it is trusted again.' },
};

export type ErrorClass = 'transient' | 'permanent' | 'conditional' | 'security';

export type AdapterCheck =
  | { ok: true; accountRef: string; capabilities: Partial<Record<Capability, CapabilityMode>>; apiVersion?: string }
  | { ok: false; errorClass: ErrorClass; message: string };

/**
 * What a real provider adapter implements. `testConnection` must call the provider and verify identity and scopes - it must
 * never return ok because "the key looks right". An adapter that cannot reach its provider returns a classified failure.
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  testConnection(context: { environment: (typeof PROVIDER_ENVIRONMENTS)[number]; credential: (name: string) => string | null; signal: AbortSignal }): Promise<AdapterCheck>;
}

/**
 * Spec §53: transient (retry with backoff), permanent (stop), conditional (wait for a person), security (stop and escalate).
 * `status` is the HTTP status when there is one; `timedOut` / `networkError` when the call never completed.
 */
export function classifyProviderError(input: { status?: number; timedOut?: boolean; networkError?: boolean; signatureInvalid?: boolean; tenantMismatch?: boolean; credentialExpired?: boolean; permissionMissing?: boolean }): ErrorClass {
  if (input.signatureInvalid || input.tenantMismatch) return 'security';
  if (input.credentialExpired || input.permissionMissing || input.status === 401 || input.status === 403) return 'conditional';
  if (input.timedOut || input.networkError) return 'transient';
  const s = input.status ?? 0;
  if (s === 408 || s === 425 || s === 429 || (s >= 500 && s <= 599)) return 'transient';
  if (s >= 400 && s < 500) return 'permanent';
  return 'permanent';
}

/**
 * Exponential backoff with full jitter, honouring Retry-After (spec §53, §129). Attempt 1 is the first retry.
 * `random` is injected so the schedule is testable; capped so a long outage cannot push a retry out for days.
 */
export function backoffSeconds(attempt: number, options: { retryAfterSeconds?: number; random?: () => number; baseSeconds?: number; capSeconds?: number } = {}): number {
  const base = options.baseSeconds ?? 30;
  const cap = options.capSeconds ?? 3600;
  const random = options.random ?? Math.random;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(random() * exp) + 1;
  const floor = options.retryAfterSeconds && options.retryAfterSeconds > 0 ? Math.min(options.retryAfterSeconds, cap) : 0;
  return Math.max(jittered, floor);
}

/** Only these classes may be retried automatically; the rest wait for a person or stop. */
export const isRetryable = (c: ErrorClass) => c === 'transient';
