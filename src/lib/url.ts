/**
 * Restricts a post-login redirect to same-origin paths.
 *
 * An open redirect on an auth flow is a phishing primitive: an attacker sends
 * /login?next=https://evil.example, the victim authenticates on a domain they
 * trust, and is then handed to the attacker's page still feeling safe. Only
 * relative paths are ever honoured.
 */
export function safeRedirectPath(
  value: string | null | undefined,
  fallback = '/dashboard',
): string {
  if (!value) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback; // protocol-relative → external
  if (value.includes('\\')) return fallback; // backslash normalisation tricks
  if (value.includes('\n') || value.includes('\r')) return fallback; // header splitting
  return value;
}
