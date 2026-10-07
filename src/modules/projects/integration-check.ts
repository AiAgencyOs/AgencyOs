/**
 * Real integration checks - Phase 5 Integration spec: "configured is not verified; only an adapter verifies; a mock never does".
 *
 * An adapter calls the integration's declared check URL with the credential named by `credential_ref` (read from the environment BY NAME; the
 * value is never stored, logged or placed in evidence) and reports what it found. `verified` is recorded only on a 2xx answer, with evidence that
 * names the host, the status and the time - never a body, never a secret. Every other result is recorded as `degraded` with the class of failure,
 * and a missing credential records NOTHING as verified: the connection stays configured, and the Admin is told which secret name is unset.
 *
 * Pure but for the injected `http`, `sleep`, `env` and `record` functions, so the same code serves the Admin action and the tests, where the
 * provider is a scripted fake (429, 5xx, 401, timeout). Only the REAL provider is unproven; the decisions are not.
 */

/** A check may authenticate only with a secret created FOR integrations, named INTEGRATION_...: never an arbitrary server variable (a service key, the cron or report secret, the git token). */
export const INTEGRATION_SECRET_NAME = /^INTEGRATION_[A-Z0-9_]{2,50}$/;

/**
 * The URL a check may call: https, no embedded credentials, and not a loopback, private, link-local or internal address. A person who can set a
 * target must not be able to aim the server at its own network (SSRF). A hostname that only RESOLVES to a private address is outside what a
 * string check can see: a deployment egress policy is the second layer (docs/phase-5-github-actions-build.md lists it as an owner step).
 */
export function isSafeCheckUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || !h.includes('.') && !h.includes(':')) return false;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
  }
  if (h.includes(':') && (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:'))) return false;
  return true;
}

export type CheckClass = 'ok' | 'unauthorized' | 'not_found' | 'rate_limited' | 'server_error' | 'timeout' | 'network' | 'credential_missing' | 'no_target';

export type HttpResult = { status: number; retryAfterSeconds?: number | null };
export type HttpClient = (request: { url: string; headers: Record<string, string>; timeoutMs: number }) => Promise<HttpResult>;

export function classifyStatus(status: number): CheckClass {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'server_error' : 'not_found';
}

/** Retryable: a throttle, a server error, a timeout or a dropped connection. Never a refusal of the credential or a missing endpoint. */
export function isRetryable(c: CheckClass): boolean {
  return c === 'rate_limited' || c === 'server_error' || c === 'timeout' || c === 'network';
}

/** Exponential backoff, capped, honouring Retry-After when the provider sent one. Deterministic jitter (no clock, no randomness): a seed in, a delay out. */
export function backoffMs(attempt: number, retryAfterSeconds: number | null | undefined, seed = 0): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.min(retryAfterSeconds, 60) * 1000;
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return base + ((seed * 7919 + attempt * 104729) % 250);
}

/** What one check measured: the class, the HTTP status the provider answered with (null when nothing answered) and how long the call took. */
export type CheckLogEntry = { checkClass: CheckClass; httpStatus: number | null; latencyMs: number | null };

export type CheckOutcome = { recorded: 'verified' | 'degraded' | 'nothing'; checkClass: CheckClass; attempts: number; detail: string };

export async function runIntegrationCheck(input: {
  connection: { id: string; checkUrl: string | null; credentialRef: string | null; isMock: boolean; health: string; kind: string };
  adapter: string;
  http: HttpClient;
  env: Readonly<Record<string, string | undefined>>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Records through `projects.record_integration_check` (service role). Resolves to the door's outcome. */
  record: (args: { ok: boolean; evidence: string }) => Promise<string>;
  /** Records the class through `projects.note_integration_check`. */
  note: (checkClass: CheckClass) => Promise<void>;
  /**
   * Records the class WITH the measurement through `projects.log_integration_check` (HTTP status and latency from the injected clock). When given it
   * is used instead of `note`, so one check is one log row; a check that asked nothing of the provider (no target, no credential) carries no
   * measurement, never a made-up one.
   */
  log?: (entry: CheckLogEntry) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
}): Promise<CheckOutcome> {
  const { connection: c } = input;
  const report = (entry: CheckLogEntry) => (input.log ? input.log(entry) : input.note(entry.checkClass));
  const max = input.maxAttempts ?? 3;
  if (c.isMock) {
    return { recorded: 'nothing', checkClass: 'no_target', attempts: 0, detail: 'a mock integration is never verified: a mock success proves nothing about a provider' };
  }
  if (!c.checkUrl) {
    await report({ checkClass: 'no_target', httpStatus: null, latencyMs: null });
    return { recorded: 'nothing', checkClass: 'no_target', attempts: 0, detail: 'no check URL is set for this integration' };
  }
  if (!isSafeCheckUrl(c.checkUrl)) {
    await report({ checkClass: 'no_target', httpStatus: null, latencyMs: null });
    return { recorded: 'nothing', checkClass: 'no_target', attempts: 0, detail: 'the check URL is not an allowed address (https only, no credentials in the URL, no loopback, private or internal host); nothing was called' };
  }
  if (c.credentialRef && !INTEGRATION_SECRET_NAME.test(c.credentialRef)) {
    await report({ checkClass: 'credential_missing', httpStatus: null, latencyMs: null });
    return { recorded: 'nothing', checkClass: 'credential_missing', attempts: 0, detail: 'a check authenticates only with a secret named INTEGRATION_... ; this name is not one, so nothing was sent' };
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (c.credentialRef) {
    const secret = input.env[c.credentialRef];
    if (!secret) {
      await report({ checkClass: 'credential_missing', httpStatus: null, latencyMs: null });
      return { recorded: 'nothing', checkClass: 'credential_missing', attempts: 0, detail: `the secret named ${c.credentialRef} is not set; nothing was checked and nothing was verified` };
    }
    headers.authorization = `Bearer ${secret}`;
  }

  let last: CheckClass = 'network';
  let attempts = 0;
  let lastStatus: number | null = null;
  let lastLatency: number | null = null;
  for (let attempt = 1; attempt <= max; attempt += 1) {
    attempts = attempt;
    let retryAfter: number | null | undefined = null;
    const startedAt = input.now().getTime();
    const elapsed = () => Math.max(0, Math.round(input.now().getTime() - startedAt));
    try {
      const res = await input.http({ url: c.checkUrl, headers, timeoutMs: input.timeoutMs ?? 10_000 });
      lastLatency = elapsed();
      lastStatus = res.status;
      last = classifyStatus(res.status);
      retryAfter = res.retryAfterSeconds;
      if (last === 'ok') {
        const host = new URL(c.checkUrl).host;
        const evidence = `HTTP ${res.status} from ${host} at ${input.now().toISOString()} by adapter ${input.adapter}`;
        const outcome = await input.record({ ok: true, evidence });
        await report({ checkClass: 'ok', httpStatus: lastStatus, latencyMs: lastLatency });
        return { recorded: outcome === 'verified' ? 'verified' : 'nothing', checkClass: 'ok', attempts, detail: outcome === 'verified' ? evidence : `the door answered ${outcome}` };
      }
    } catch (error) {
      lastStatus = null;
      lastLatency = elapsed();
      last = error instanceof Error && /timeout|abort/i.test(error.name + error.message) ? 'timeout' : 'network';
    }
    if (!isRetryable(last) || attempt === max) break;
    await input.sleep(backoffMs(attempt, retryAfter, attempt));
  }
  const evidence = `check failed: ${last.replace(/_/g, ' ')} after ${attempts} attempt(s)`;
  const outcome = await input.record({ ok: false, evidence });
  await report({ checkClass: last, httpStatus: lastStatus, latencyMs: lastLatency });
  return { recorded: outcome === 'degraded' ? 'degraded' : 'nothing', checkClass: last, attempts, detail: evidence };
}
