import { SECRET_PATTERNS } from '@/lib/security/secret-patterns';

/**
 * SCR-024 — "Secrets/credentials must never be stored in normal shared project
 * files". A guard over what a person is about to file: the file's name, the link
 * they paste, the title and description they type and — for a small text file
 * being uploaded — its first few kilobytes. It refuses only what is recognisably
 * a credential (the shapes `src/lib/security/secret-patterns.ts` already holds,
 * a key or vault file by name, a password inside a link, a "password: value"
 * line); it does not claim to find every secret, and the form says so.
 * Credentials belong in Settings › Keys & secrets, which encrypts them.
 */
export const SECRETS_WARNING =
  'Never file a password, API key, token or private key here — project files are shared with the whole team. Put credentials in Settings › Keys & secrets, which stores them encrypted.';

const SENSITIVE_NAME: readonly { re: RegExp; what: string }[] = [
  { re: /(^|[\\/])\.env(\.[\w.-]+)?$/i, what: 'an environment file' },
  { re: /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, what: 'an SSH key' },
  { re: /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i, what: 'a key or certificate store' },
  { re: /(^|[\\/])(\.npmrc|\.htpasswd|\.netrc|\.pgpass)$/i, what: 'a credentials file' },
  { re: /(^|[\\/])(credentials|secrets?|passwords?)(\.[\w]+)?$/i, what: 'a credentials file' },
  { re: /service[-_]?account.*\.json$/i, what: 'a service-account key' },
];

const SECRET_QUERY = /[?&#](?:password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|apikey|client_secret|auth)=[^&\s]{6,}/i;
const PASSWORD_LINE = /\b(?:password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*\S{6,}/i;

export type FilingCandidate = { title?: string | null; description?: string | null; url?: string | null; fileName?: string | null; text?: string | null };

/** Why this must not be filed, in words, or null when nothing recognisable is in it. */
export function fileCredentialProblem(c: FilingCandidate): string | null {
  if (c.fileName) {
    for (const s of SENSITIVE_NAME) if (s.re.test(c.fileName)) return `“${c.fileName}” looks like ${s.what}. ${SECRETS_WARNING}`;
  }
  if (c.url) {
    try {
      const u = new URL(c.url);
      if (u.password) return `That link has a password inside it. ${SECRETS_WARNING}`;
    } catch {
      /* the schema judges whether it is a URL; this guard only reads a parsed one */
    }
    if (SECRET_QUERY.test(c.url)) return `That link carries a secret (a token, key or password in its address). ${SECRETS_WARNING}`;
  }
  for (const text of [c.title, c.description, c.url, c.text]) {
    if (!text) continue;
    for (const p of SECRET_PATTERNS) if (p.re.test(text)) return `That looks like a ${p.name}. ${SECRETS_WARNING}`;
  }
  for (const text of [c.title, c.description, c.text]) {
    if (text && PASSWORD_LINE.test(text)) return `That contains a line that looks like a password or key. ${SECRETS_WARNING}`;
  }
  return null;
}

/** Text files small enough to read before filing. */
export const SCANNABLE_TEXT = /\.(txt|md|json|ya?ml|env|csv|ini|conf|cfg|toml|sh|properties)$/i;
export const SCAN_BYTES = 256 * 1024;
