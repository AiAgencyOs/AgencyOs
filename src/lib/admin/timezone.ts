/**
 * Is this a timezone the runtime recognises? Asking Intl to construct a
 * formatter with the zone is the authoritative check — it throws RangeError for
 * anything the IANA database does not name, the same answer Postgres's IANA
 * CHECK gives one layer down.
 *
 * Kept in its own dependency-free module (no next/headers, no server-only) so
 * it is directly unit-testable and so the settings write path can validate
 * before it ever touches a request context.
 */
export function isValidTimeZone(timezone: string): boolean {
  const tz = timezone.trim();
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
