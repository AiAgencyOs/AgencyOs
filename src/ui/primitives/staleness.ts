/**
 * "3h ago", not a raw second count — the phrasing every stale-data warning on
 * this admin panel used to write out by hand (Operations' scheduler tick,
 * originally). `null` means the age itself could not be read, which is a
 * different fact from "it has been a while" and gets its own word rather than
 * a fabricated number.
 */
export function ageLabel(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  if (seconds > 3600) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds > 90) return `${Math.floor(seconds / 60)}m ago`;
  return `${seconds}s ago`;
}
