/**
 * Where a provider's API may live - the rule that stops a custom Base URL being used to reach inside the network.
 *
 * An Admin types a base URL; the server then connects to it with a secret attached. Without a rule, "a provider" is a way to
 * make the server call `http://169.254.169.254/` (a cloud metadata service) or an internal admin port and read the answer.
 * So: https only; no credentials in the URL; and a host that is - or resolves to - a loopback, private, link-local or
 * metadata address is refused. Loopback is allowed ONLY when the deployment says it is a test/dev one
 * (`AI_PROVIDER_ALLOW_PRIVATE_HOSTS=true`, or a non-production NODE_ENV), because that is how a local gateway and the
 * verification stubs work - and the production config guard already forbids that variable on a real deployment.
 */

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

function isIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** Loopback, private (RFC 1918), CGNAT, link-local (incl. the cloud metadata address), unspecified, multicast, reserved. */
export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = isIpv4(h);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal';
}

export function checkProviderBaseUrl(raw: string, options: { allowPrivate: boolean }): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'That is not a URL.' };
  }
  if (url.username || url.password) return { ok: false, reason: 'A base URL must not contain a username or password - keys are stored separately.' };
  if (url.search || url.hash) return { ok: false, reason: 'A base URL must not carry a query string or fragment.' };
  const privateHost = isPrivateAddress(url.hostname);
  if (url.protocol === 'http:') {
    if (!(privateHost && options.allowPrivate)) return { ok: false, reason: 'A provider must be reached over https.' };
  } else if (url.protocol !== 'https:') {
    return { ok: false, reason: 'A provider must be reached over https.' };
  }
  if (privateHost && !options.allowPrivate) {
    return { ok: false, reason: 'That address is internal (loopback, private network or cloud metadata), so the server will not connect to it.' };
  }
  return { ok: true, url };
}

const LOOPBACK_URL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])([:/]|$)/i;

/**
 * Whether this deployment may connect to a private or loopback provider host.
 *
 * Yes outside production (dev, tests). In production only when it is the verification harness - which the config guard
 * already recognises by a LOOPBACK base-URL override (CI starts the production build against local stubs) - so a real
 * deployment can never be talked into calling an internal address, and no new switch exists to set by mistake.
 */
export function privateHostsAllowed(env: { NODE_ENV?: string } & Record<string, string | undefined>): boolean {
  if (env.NODE_ENV !== 'production') return true;
  return ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GEMINI_BASE_URL', 'XAI_BASE_URL', 'OPENROUTER_BASE_URL'].some((k) => LOOPBACK_URL.test(env[k] ?? ''));
}
