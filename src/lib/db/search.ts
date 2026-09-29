/**
 * Search within a domain — the shared rule (PDF §3, bucket G-3).
 *
 * A list page reads `?q=` and hands it to its reader, which filters SERVER-
 * SIDE with one PostgREST `or=` over the human-named columns. The two
 * helpers here are the only place the text is turned into a pattern, so
 * every page escapes the same way:
 *
 *   • `%` and `_` are LIKE wildcards and are escaped with a backslash so a
 *     person searching for "50%" finds "50%", not everything.
 *   • The value is double-quoted inside the `or=` grammar, because PostgREST
 *     splits an unquoted value on `,` `.` `(` `)`; a quote inside the text is
 *     escaped with a backslash, which the quoted-string grammar honours.
 *   • `*` is PostgREST's own wildcard in `ilike`, wrapped around the value.
 *
 * Pure and dependency-free so a reader in `src/modules` or `src/lib` can use
 * it and a test can pin the escaping.
 */

/** The `?q=` as a reader wants it: trimmed, bounded, empty when it was blank. */
export function normaliseSearch(q: string | undefined | null, max = 120): string {
  return (q ?? '').trim().slice(0, max);
}

/** The search text as a quoted PostgREST `ilike` operand: `"*text*"` with wildcards and quotes escaped. */
export function ilikeOperand(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/"/g, '\\"');
  return `"*${escaped}*"`;
}

/**
 * One `or=` filter over several columns: `a.ilike."*q*",b.ilike."*q*"`.
 * A column may be an embedded path (`leads.title`) when the caller passes
 * `referencedTable` to `.or()`; the helper does not care.
 */
export function ilikeAny(columns: readonly string[], q: string): string {
  const operand = ilikeOperand(q);
  return columns.map((c) => `${c}.ilike.${operand}`).join(',');
}
